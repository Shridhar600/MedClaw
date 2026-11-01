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
  /** Distinguishes parallel calls with identical args so idempotency keys never collide. */
  toolCallId?: string;
  /** Who started the turn. Owner-only tools need 'user'; absent is refused. */
  origin?: 'user' | 'heartbeat' | 'background';
}

export interface Tool {
  name: string;
  group: string;
  description: string;
  parameters: ToolParameters;
  /** Only an owner turn may use this tool; background turns never see it. */
  ownerTurnOnly?: boolean;
  execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
