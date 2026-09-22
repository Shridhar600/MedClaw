export interface ToolResultContent {
  type: 'text' | 'image';
  text: string;
}

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolExecutionContext {
  chatId?: string;
  /** Opaque identity shared by every tool call in one AgentLoop.run invocation. */
  turnId?: string;
  /** RR-STRUCT R-S3: the provider's per-call id (OpenAI `tool_call.id`) — disambiguates two
   *  parallel calls to the SAME tool with otherwise-identical arguments within one turn, so an
   *  idempotency key built from (chatId, turnId, toolCallId, params) never collides them. */
  toolCallId?: string;
}

export interface Tool {
  name: string;
  group: string;
  description: string;
  parameters: ToolParameters;
  execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
