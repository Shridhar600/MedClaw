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

export interface Tool {
  name: string;
  group: string;
  description: string;
  parameters: ToolParameters;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
