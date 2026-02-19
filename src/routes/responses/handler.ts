import type { Context } from "hono"
import type { SSEMessage } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { HTTPError, forwardError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  isResponsesResponse,
  isResponsesStream,
} from "~/services/copilot/create-responses"
import type { ResponsesPayload } from "./types"
import {
  translateChatChunkToResponsesEvents,
  translateChatResponseToResponses,
  translateResponsesToChatPayload,
} from "./translation"

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const rawBody = await c.req.text()
  const debug = state.debugLogging
  
  if (debug) {
    consola.info("=== /v1/responses REQUEST ===")
    consola.info("Request body length:", rawBody.length, "characters")
  }
  
  let payload: ResponsesPayload
  try {
    payload = JSON.parse(rawBody)
  } catch (e) {
    consola.error("Failed to parse request body:", e)
    return c.json({ error: { message: "Invalid JSON body" } }, 400)
  }
  
  if (debug) {
    consola.info("Model:", payload.model)
    consola.info("Input items count:", payload.input?.length)
  }
  
  // Collect function_call call_ids for orphan detection
  const functionCallIds = new Set<string>()
  if (payload.input) {
    for (const item of payload.input) {
      if ("type" in item && item.type === "function_call") {
        functionCallIds.add(item.call_id)
      }
    }
  }
  
  // Log input items if debug enabled
  if (debug && payload.input) {
    consola.info("Input items:")
    for (let i = 0; i < payload.input.length; i++) {
      const item = payload.input[i] as unknown as Record<string, unknown>
      if ("type" in item) {
        const itemType = String(item.type)
        if (itemType === "function_call") {
          consola.info(`  [${i}] function_call, call_id: ${item.call_id}`)
        } else if (itemType === "function_call_output") {
          consola.info(`  [${i}] function_call_output, call_id: ${item.call_id}`)
        } else if (itemType === "item_reference") {
          consola.info(`  [${i}] item_reference, id: ${item.id}`)
        } else if (itemType === "message") {
          consola.info(`  [${i}] message, role: ${item.role}`)
        } else {
          consola.info(`  [${i}] ${itemType}`)
        }
      } else if ("role" in item) {
        consola.info(`  [${i}] role:${item.role}`)
      } else {
        consola.info(`  [${i}] unknown`)
      }
    }
  }
  
  // Check for orphan function_call_output items
  const orphanOutputs: string[] = []
  if (payload.input) {
    for (const item of payload.input) {
      if ("type" in item && item.type === "function_call_output") {
        if (!functionCallIds.has(item.call_id)) {
          orphanOutputs.push(item.call_id)
        }
      }
    }
  }
  
  if (orphanOutputs.length > 0) {
    consola.warn(`Found ${orphanOutputs.length} orphan function_call_output items (no matching function_call)`)
    if (debug) {
      consola.warn("This is likely a Continue.dev issue - sending tool results without tool calls")
      consola.warn("Orphan call_ids:", orphanOutputs.slice(0, 5).join(", "), orphanOutputs.length > 5 ? "..." : "")
    }
    consola.warn("Filtering out orphan items to allow request to proceed...")
    
    // Filter out orphan function_call_output items
    payload.input = payload.input.filter((item) => {
      if ("type" in item && item.type === "function_call_output") {
        return functionCallIds.has(item.call_id)
      }
      return true
    })
    
    if (debug) {
      consola.info("Filtered input items count:", payload.input.length)
    }
  }
  
  if (debug) {
    consola.info("=== END REQUEST ===")
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  if (isNullish(payload.max_output_tokens)) {
    payload = {
      ...payload,
      max_output_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
  }

  const endpoints = selectedModel?.supported_endpoints
  const supportsResponses = !endpoints || endpoints.includes("/responses")
  const supportsChatCompletions = !endpoints || endpoints.includes("/chat/completions")

  let lastError: Error | null = null

  if (supportsResponses) {
    try {
      consola.debug("Trying /responses endpoint for model:", payload.model)
      const response = await createResponses(payload)

      if (isResponsesResponse(response)) {
        consola.debug("Non-streaming responses:", JSON.stringify(response).slice(-400))
        return c.json(response)
      }

      if (isResponsesStream(response)) {
        consola.debug("Streaming responses")
        return streamSSE(c, async (stream) => {
          for await (const chunk of response) {
            consola.debug("Streaming chunk:", JSON.stringify(chunk))
            await stream.writeSSE(chunk as SSEMessage)
          }
        })
      }
    } catch (error) {
      consola.warn("Responses endpoint failed:", error)
      lastError = error instanceof Error ? error : new Error(String(error))

      if (!shouldFallbackToChat(error, supportsChatCompletions)) {
        return forwardError(c, error)
      }
    }
  }

  if (supportsChatCompletions && lastError) {
    try {
      consola.debug("Falling back to /chat/completions for model:", payload.model)

      const chatPayload = translateResponsesToChatPayload(payload)
      consola.debug("Translated to chat payload:", JSON.stringify(chatPayload, null, 2))

      const chatResponse = await createChatCompletions(chatPayload)

      if (isNonStreaming(chatResponse)) {
        const responsesResponse = translateChatResponseToResponses(chatResponse)
        consola.debug("Translated response:", JSON.stringify(responsesResponse).slice(-400))
        return c.json(responsesResponse)
      }

      consola.debug("Streaming with translation")
      return streamSSE(c, async (stream) => {
        const streamState = {
          responseId: "",
          sentCreated: false,
          currentItemIndex: 0,
          toolCallIds: new Map<number, string>(),
        }

        for await (const chunk of chatResponse) {
          consola.debug("Chat chunk:", JSON.stringify(chunk))
          const data = (chunk as { data?: string }).data
          if (data && data !== "[DONE]") {
            try {
              const parsed = JSON.parse(data)
              const events = translateChatChunkToResponsesEvents(parsed, streamState)
              for (const event of events) {
                await stream.writeSSE({
                  data: JSON.stringify(event),
                } as SSEMessage)
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      })
    } catch (error) {
      consola.error("Chat completions fallback also failed:", error)
      return forwardError(c, error)
    }
  }

  if (lastError) {
    return forwardError(c, lastError)
  }

  return c.json(
    {
      error: {
        type: "invalid_request_error",
        message: `Model '${payload.model}' does not support any compatible endpoint`,
      },
    },
    400,
  )
}

function shouldFallbackToChat(error: unknown, supportsChat: boolean): boolean {
  if (!supportsChat) return false
  if (!(error instanceof HTTPError)) return false

  const status = error.response.status
  return status === 400 || status === 404 || status === 422
}

function isNonStreaming(
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}
