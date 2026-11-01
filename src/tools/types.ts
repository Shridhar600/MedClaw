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
  /** The provider's per-call id (OpenAI `tool_call.id`). It tells apart two parallel calls to the
   *  same tool with identical arguments in one turn, so an idempotency key never collides them. */
  toolCallId?: string;
  /** Who started the turn. Absent means an owner turn. */
  origin?: 'user' | 'heartbeat' | 'background';
}

export interface Tool {
  name: string;
  group: string;
  description: string;
  parameters: ToolParameters;
  /** Only an owner turn may use this tool (medical writes and confirmations); background turns never see it. */
  ownerTurnOnly?: boolean;
  execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
