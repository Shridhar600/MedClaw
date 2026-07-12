// src/providers/openai.ts
import OpenAI from 'openai';
import type { ImageAttachment, LLMProvider, LLMResponse, Message, ToolSchema } from './types';
import type { ProviderConfig } from '../config/types';

function resolveProviderApiKey(config: ProviderConfig): string | undefined {
  if (config.apiKey?.trim()) {
    return config.apiKey;
  }

  switch (config.type) {
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'google':
      return process.env.GOOGLE_API_KEY;
    case 'ollama':
      return undefined;
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly modelName: string;
  private client: OpenAI;
  private model: string;

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: resolveProviderApiKey(config),
      baseURL: config.baseUrl,
    });
    this.model = config.model;
    this.modelName = config.model;
  }

  async chat(messages: Message[], tools?: ToolSchema[]): Promise<LLMResponse> {
    // Cast messages — OpenAI SDK types are compatible with our interface
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    };
    if (tools && tools.length > 0) {
      params.tools = tools as OpenAI.Chat.ChatCompletionTool[];
    }

    const completion = await this.client.chat.completions.create(params);
    const message = completion.choices[0].message;

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
    const formattedMessages = messages.map((message) => ({
      role: message.role,
      content: message.content ?? '',
    })) as Array<{ role: string; content: unknown }>;

    const lastUserIndex = findLastIndex(formattedMessages, (message) => message.role === 'user');
    const targetIndex = lastUserIndex >= 0 ? lastUserIndex : formattedMessages.length - 1;
    const text = String(formattedMessages[targetIndex].content ?? '');
    formattedMessages[targetIndex].content = [
      { type: 'text', text },
      ...images.map((image) => ({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      })),
    ];

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: formattedMessages as OpenAI.Chat.ChatCompletionMessageParam[],
    });
    const message = completion.choices[0].message;

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

  async embed(text: string): Promise<number[]> {
    const result = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return result.data[0].embedding;
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}
