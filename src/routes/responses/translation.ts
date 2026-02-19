import consola from "consola"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesPayload,
  ResponsesResponse,
  ResponsesTool,
} from "./types"

export function translateResponsesToChatPayload(
  responsesPayload: ResponsesPayload,
): ChatCompletionsPayload {
  const messages: Array<Message> = []

  if (responsesPayload.instructions) {
    messages.push({
      role: "system",
      content: responsesPayload.instructions,
    })
  }

  consola.debug("Translating Responses input to Chat Completions messages...")
  
  for (const item of responsesPayload.input) {
    consola.debug("Input item:", JSON.stringify(item).slice(0, 200))
    const translated = translateInputItemToMessage(item)
    if (translated) {
      if (Array.isArray(translated)) {
        messages.push(...translated)
      } else {
        messages.push(translated)
      }
    }
  }

  // Validate tool message ordering
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === "tool") {
      // Check if previous message has tool_calls
      const prevMsg = messages[i - 1]
      if (!prevMsg || prevMsg.role !== "assistant" || !prevMsg.tool_calls) {
        consola.warn("Tool message at index", i, "has no preceding assistant with tool_calls")
        consola.warn("Previous message:", prevMsg)
        consola.warn("Tool message:", msg)
      }
    }
  }

  return {
    model: responsesPayload.model,
    messages,
    temperature: responsesPayload.temperature,
    top_p: responsesPayload.top_p,
    max_tokens: responsesPayload.max_output_tokens,
    stream: responsesPayload.stream,
    tools: responsesPayload.tools?.map(translateResponsesToolToChatTool),
    tool_choice: translateToolChoice(responsesPayload.tool_choice),
  }
}

function translateInputItemToMessage(
  item: ResponsesInputItem,
): Message | Array<Message> | null {
  if ("role" in item) {
    switch (item.role) {
      case "system":
        return { role: "system", content: item.content }
      case "developer":
        return { role: "developer", content: item.content }
      case "user":
        return {
          role: "user",
          content: translateResponsesContentToChatContent(item.content),
        }
      case "assistant":
        return {
          role: "assistant",
          content: translateResponsesContentToChatContent(item.content),
        }
    }
  }

  switch (item.type) {
    case "function_call":
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments,
            },
          },
        ],
      }
    case "function_call_output":
      return {
        role: "tool",
        tool_call_id: item.call_id,
        content:
          typeof item.output === "string"
            ? item.output
            : item.output.map((p) => (p.type === "output_text" ? p.text : "")).join(""),
      }
    case "item_reference":
      return null
  }

  return null
}

function translateResponsesContentToChatContent(
  content: string | Array<ResponsesContentPart>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content || null
  }

  const parts: Array<ContentPart> = []
  for (const part of content) {
    switch (part.type) {
      case "input_text":
      case "output_text":
        return part.text
      case "input_image":
        parts.push({
          type: "image_url",
          image_url: { url: part.image_url, detail: part.detail },
        })
        break
      case "input_file":
        break
    }
  }

  return parts.length > 0 ? parts : null
}

function translateResponsesToolToChatTool(tool: ResponsesTool): Tool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function translateToolChoice(
  toolChoice: ResponsesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!toolChoice) return undefined
  if (typeof toolChoice === "string") {
    return toolChoice
  }
  return { type: "function", function: { name: toolChoice.name } }
}

export function translateChatResponseToResponses(
  chatResponse: ChatCompletionResponse,
): ResponsesResponse {
  const output: Array<ResponsesOutputItem> = []

  for (const choice of chatResponse.choices) {
    const message = choice.message

    if (message.content) {
      output.push({
        type: "message",
        id: `msg_${chatResponse.id}_${choice.index}`,
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
        status: "completed",
      })
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        output.push({
          type: "function_call",
          id: toolCall.id,
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          status: "completed",
        })
      }
    }
  }

  return {
    id: chatResponse.id,
    object: "response",
    created_at: chatResponse.created,
    model: chatResponse.model,
    output,
    usage: chatResponse.usage
      ? {
          input_tokens: chatResponse.usage.prompt_tokens,
          output_tokens: chatResponse.usage.completion_tokens,
          total_tokens: chatResponse.usage.total_tokens,
        }
      : undefined,
    status: "completed",
  }
}

export function translateChatChunkToResponsesEvents(
  chunk: {
    id: string
    model: string
    created: number
    choices: Array<{
      index: number
      delta: {
        content?: string | null
        role?: string
        tool_calls?: Array<{
          index: number
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      }
      finish_reason: string | null
    }>
  },
  state: {
    responseId: string
    sentCreated: boolean
    currentItemIndex: number
    toolCallIds: Map<number, string>
  },
): Array<{ type: string; [key: string]: unknown }> {
  const events: Array<{ type: string; [key: string]: unknown }> = []

  if (!state.sentCreated) {
    state.sentCreated = true
    state.responseId = chunk.id
    events.push({
      type: "response.created",
      response: {
        id: chunk.id,
        created_at: chunk.created,
        model: chunk.model,
      },
    })
  }

  for (const choice of chunk.choices) {
    const delta = choice.delta

    if (delta.content) {
      events.push({
        type: "response.output_text.delta",
        item_id: `msg_${chunk.id}_${choice.index}`,
        output_index: choice.index,
        delta: delta.content,
      })
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const toolCallId = state.toolCallIds.get(tc.index) || tc.id
        if (tc.id) {
          state.toolCallIds.set(tc.index, tc.id)
        }

        if (tc.function?.name) {
          events.push({
            type: "response.output_item.added",
            output_index: tc.index,
            item: {
              type: "function_call",
              id: toolCallId || `call_${tc.index}`,
              call_id: toolCallId || `call_${tc.index}`,
              name: tc.function.name,
              arguments: "",
            },
          })
        }

        if (tc.function?.arguments) {
          events.push({
            type: "response.function_call_arguments.delta",
            item_id: toolCallId || `call_${tc.index}`,
            output_index: tc.index,
            delta: tc.function.arguments,
          })
        }
      }
    }

    if (choice.finish_reason) {
      events.push({
        type: "response.completed",
        response: {
          id: chunk.id,
          status: "completed",
        },
      })
    }
  }

  return events
}
