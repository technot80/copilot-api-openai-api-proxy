import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import type {
  ResponsesInputItem,
  ResponsesPayload,
  ResponsesResponse,
} from "~/routes/responses/types"

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const hasVision = payload.input.some(hasVisionContent)

  const isAgentCall = payload.input.some(isAgentInput)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, hasVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const url = `${copilotBaseUrl(state)}/responses`
  const body = JSON.stringify(payload)
  
  if (state.debugLogging) {
    consola.info("Calling Copilot /responses API...")
    consola.info("Request body length:", body.length, "characters")
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  })

  if (state.debugLogging) {
    consola.info("Copilot response status:", response.status, response.statusText)
  }

  if (!response.ok) {
    const errorBody = await response.text()
    consola.error("Copilot /responses FAILED")
    consola.error("Status:", response.status)
    consola.error("Error body:", errorBody || "(empty)")
    throw new HTTPError("Failed to create responses", response, errorBody)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResponse
}

function hasVisionContent(item: ResponsesInputItem): boolean {
  if ("content" in item && Array.isArray(item.content)) {
    return item.content.some((c) => c.type === "input_image")
  }
  return false
}

function isAgentInput(item: ResponsesInputItem): boolean {
  if ("role" in item && item.role === "assistant") {
    return true
  }
  if ("type" in item) {
    return item.type === "function_call" || item.type === "function_call_output"
  }
  return false
}

export const isResponsesResponse = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ResponsesResponse => Object.hasOwn(response, "output")

export const isResponsesStream = (
  response: Awaited<ReturnType<typeof createResponses>>,
): boolean => !Object.hasOwn(response, "output")
