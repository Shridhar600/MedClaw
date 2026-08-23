// src/providers/openai.ts
import OpenAI from 'openai';
import type { ImageAttachment, LLMProvider, LLMResponse, Message, ToolSchema } from './types';
import type { ProviderConfig } from '../config/types';

// OpenAI reasoning-class models (gpt-5 family, o1/o3/o4 families) reject
// function tools on /v1/chat/completions unless reasoning_effort is 'none'
// (otherwise: "Function tools with reasoning_effort are not supported ...
// use /v1/responses or set reasoning_effort to 'none'"). The agent loop always
// sends tools, so without this every turn 400s. Detected by name; 'none' also
// keeps latency low, which suits a tool-calling health agent. (A fuller move to
// the /v1/responses API is a separate decision — see forka-test-report #13.)
function isReasoningModel(model: string): boolean {
  return /^(?:gpt-5|o[1-9])/i.test(model);
}

// The installed OpenAI SDK (4.104.0) types ReasoningEffort as
// 'low'|'medium'|'high'|null and has not caught up to the 'none' value the API
// now accepts, so apply it via a typed extension rather than a bare cast.
type ChatParamsWithReasoning =
  Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, 'reasoning_effort'> & { reasoning_effort?: 'none' };

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
    if (isReasoningModel(this.model)) {
      (params as ChatParamsWithReasoning).reasoning_effort = 'none';
    }

    const completion = await this.client.chat.completions.create(params);
    const message = completion.choices[0].message;

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: 'tool_call',
        toolCalls: message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        })),
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

    const imageParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: formattedMessages as OpenAI.Chat.ChatCompletionMessageParam[],
    };
    if (isReasoningModel(this.model)) {
      (imageParams as ChatParamsWithReasoning).reasoning_effort = 'none';
    }
    const completion = await this.client.chat.completions.create(imageParams);
    const message = completion.choices[0].message;

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: 'tool_call',
        toolCalls: message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        })),
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
