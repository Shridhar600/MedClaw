import type { Message } from '../providers/types';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result: string }>;
  timestamp: Date;
}

export interface AgentContext {
  systemMessages: Message[];
  conversationHistory: Message[];
}

export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  result: string;
}
