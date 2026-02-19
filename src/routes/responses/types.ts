export type ResponsesInput = Array<ResponsesInputItem>

export type ResponsesInputItem =
  | ResponsesSystemMessage
  | ResponsesDeveloperMessage
  | ResponsesUserMessage
  | ResponsesAssistantMessage
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput
  | ResponsesItemReference
  | ResponsesMessageInput

export interface ResponsesSystemMessage {
  role: "system"
  content: string
}

export interface ResponsesDeveloperMessage {
  role: "developer"
  content: string
}

export interface ResponsesUserMessage {
  role: "user"
  content: string | Array<ResponsesContentPart>
}

export interface ResponsesAssistantMessage {
  role: "assistant"
  content: string | Array<ResponsesContentPart>
  id?: string
}

export interface ResponsesMessageInput {
  type: "message"
  role: "user" | "assistant"
  content: string | Array<ResponsesContentPart>
  id?: string
}

export interface ResponsesFunctionCall {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
  id?: string
}

export interface ResponsesFunctionCallOutput {
  type: "function_call_output"
  call_id: string
  output: string | Array<ResponsesContentPart>
}

export interface ResponsesItemReference {
  type: "item_reference"
  id: string
}

export type ResponsesContentPart =
  | ResponsesInputText
  | ResponsesInputImage
  | ResponsesInputFile
  | ResponsesOutputText

export interface ResponsesInputText {
  type: "input_text"
  text: string
}

export interface ResponsesInputImage {
  type: "input_image"
  image_url: string
  detail?: "low" | "high" | "auto"
}

export interface ResponsesInputFile {
  type: "input_file"
  file_url?: string
  filename?: string
  file_data?: string
  file_id?: string
}

export interface ResponsesOutputText {
  type: "output_text"
  text: string
}

export interface ResponsesPayload {
  model: string
  input: ResponsesInput
  instructions?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: Array<ResponsesTool>
  tool_choice?: "none" | "auto" | "required" | { type: "function"; name: string }
  metadata?: Record<string, unknown>
  store?: boolean
  previous_response_id?: string
}

export interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export interface ResponsesResponse {
  id: string
  object: "response"
  created_at: number
  model: string
  output: Array<ResponsesOutputItem>
  usage?: ResponsesUsage
  status?: "completed" | "incomplete" | "failed"
  error?: {
    type: string
    code: string
    message: string
  }
}

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall

export interface ResponsesOutputMessage {
  type: "message"
  id: string
  role: "assistant"
  content: Array<ResponsesContentPart>
  status?: string
}

export interface ResponsesOutputFunctionCall {
  type: "function_call"
  id: string
  call_id: string
  name: string
  arguments: string
  status?: string
}

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens?: number
  }
}

export type ResponsesStreamEvent =
  | ResponsesCreatedEvent
  | ResponsesOutputItemAddedEvent
  | ResponsesOutputItemDoneEvent
  | ResponsesOutputTextDeltaEvent
  | ResponsesFunctionCallArgumentsDeltaEvent
  | ResponsesCompletedEvent
  | ResponsesErrorEvent

export interface ResponsesCreatedEvent {
  type: "response.created"
  response: {
    id: string
    created_at: number
    model: string
  }
}

export interface ResponsesOutputItemAddedEvent {
  type: "response.output_item.added"
  output_index: number
  item: ResponsesOutputItem
}

export interface ResponsesOutputItemDoneEvent {
  type: "response.output_item.done"
  output_index: number
  item: ResponsesOutputItem
}

export interface ResponsesOutputTextDeltaEvent {
  type: "response.output_text.delta"
  item_id: string
  output_index: number
  delta: string
}

export interface ResponsesFunctionCallArgumentsDeltaEvent {
  type: "response.function_call_arguments.delta"
  item_id: string
  output_index: number
  delta: string
}

export interface ResponsesCompletedEvent {
  type: "response.completed"
  response: {
    id: string
    status: string
    usage?: ResponsesUsage
  }
}

export interface ResponsesErrorEvent {
  type: "error"
  error: {
    type: string
    code: string
    message: string
  }
}

export interface ResponsesStreamState {
  responseId: string
  model: string
  created: number
  outputIndex: number
  toolCallIndex: number
  toolCalls: Map<
    string,
    { id: string; name: string; call_id: string; arguments: string }
  >
  currentItemId: string | null
  finishReason: "stop" | "length" | "tool_calls" | null
  contentBuffer: string
}
