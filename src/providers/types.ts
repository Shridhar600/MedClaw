// src/providers/types.ts

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallFunction {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: MessageRole;
  content: string | null;
  tool_call_id?: string;   // For tool result messages
  tool_calls?: Array<{     // For assistant tool request messages
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ImageAttachment {
  mimeType: 'image/png' | 'image/jpeg';
  data: string;            // Raw base64 without a data: prefix.
  filename?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface TextResponse {
  type: 'text';
  text: string;
}

/** Token consumption for the request (seam for the future eval/cost pipeline). */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResponse {
  type: 'tool_call';
  /** ALL tool calls the model requested this turn — parallel-safe (C4.1); never just the first. */
  toolCalls: ToolCall[];
}

/** Both response variants carry usage when the provider reports it (never required). */
export type LLMResponse = (TextResponse | ToolCallResponse) & { usage?: TokenUsage };

export interface LLMProvider {
  readonly modelName?: string;
  chat(messages: Message[], tools?: ToolSchema[]): Promise<LLMResponse>;
  chatWithImages?(messages: Message[], images: ImageAttachment[]): Promise<LLMResponse>;
  embed(text: string): Promise<number[]>;
}

export interface AgentRunResult {
  text: string;
  trace: Message[];
  usedTools: string[];
  healthResponse: boolean;
}
