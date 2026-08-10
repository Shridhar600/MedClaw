// src/providers/ollama.ts
import type { ImageAttachment, LLMProvider, LLMResponse, Message, ToolSchema } from './types';
import type { ProviderConfig } from '../config/types';

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
    };

    const message = data.choices[0].message;

    if (message.tool_calls && message.tool_calls.length > 0) {
      const tc = message.tool_calls[0];
      return {
        type: 'tool_call',
        toolCall: {
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        },
      };
    }

    return { type: 'text', text: message.content ?? '' };
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

    const toolCall = data.message.tool_calls?.[0];
    if (toolCall) {
      return {
        type: 'tool_call',
        toolCall: {
          id: toolCall.id ?? 'ollama_vision_tool_call',
          name: toolCall.function.name,
          arguments: typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments) as Record<string, unknown>
            : toolCall.function.arguments,
        },
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
