// src/providers/ollama.ts
import type { ImageAttachment, LLMProvider, LLMResponse, Message, TokenUsage, ToolSchema } from './types';
import type { ProviderConfig } from '../config/types';

/** Map the OpenAI-compat wire `usage` object onto our TokenUsage (undefined when absent). */
function toTokenUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
} | undefined): TokenUsage | undefined {
  if (!usage || usage.prompt_tokens === undefined || usage.completion_tokens === undefined) {
    return undefined;
  }
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

export class OllamaProvider implements LLMProvider {
  readonly modelName: string;
  private baseUrl: string;
  private model: string;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434/v1';
    this.model = config.model;
    this.modelName = config.model;
  }

  async chat(messages: Message[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama API error: ${response.status} — ${text}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };

    const message = data.choices[0].message;
    const usage = toTokenUsage(data.usage);

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: 'tool_call',
        toolCalls: message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        })),
        usage,
      };
    }

    return { type: 'text', text: message.content ?? '', usage };
  }

  async chatWithImages(messages: Message[], images: ImageAttachment[]): Promise<LLMResponse> {
    const requestMessages = messages.map((message) => ({
      role: message.role,
      content: message.content ?? '',
    })) as Array<{ role: string; content: string; images?: string[] }>;

    const lastUserIndex = findLastIndex(requestMessages, (message) => message.role === 'user');
    const targetIndex = lastUserIndex >= 0 ? lastUserIndex : requestMessages.length - 1;
    requestMessages[targetIndex].images = images.map((image) => image.data);

    const response = await fetch(`${this.nativeBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: requestMessages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama vision API error: ${response.status} — ${text}`);
    }

    const data = await response.json() as {
      message: {
        content: string | null;
        tool_calls?: Array<{
          id?: string;
          function: { name: string; arguments: Record<string, unknown> | string };
        }>;
      };
    };

    const visionToolCalls = data.message.tool_calls;
    if (visionToolCalls && visionToolCalls.length > 0) {
      return {
        type: 'tool_call',
        toolCalls: visionToolCalls.map((tc, i) => ({
          id: tc.id ?? `ollama_vision_tool_call_${i}`,
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments) as Record<string, unknown>
            : tc.function.arguments,
        })),
      };
    }

    return { type: 'text', text: data.message.content ?? '' };
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama embed error: ${response.status} — ${errText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  private nativeBaseUrl(): string {
    return this.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}
