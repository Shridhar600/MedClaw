// src/providers/openai.ts
import OpenAI from 'openai';
import type { ImageAttachment, LLMProvider, LLMResponse, Message, TokenUsage, ToolSchema } from './types';
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
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY;
    case 'ollama':
      return undefined;
  }
}

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Map the OpenAI wire `usage` object onto our TokenUsage (undefined when absent). */
function toTokenUsage(usage: OpenAI.CompletionUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

export class OpenAIProvider implements LLMProvider {
  readonly modelName: string;
  /** Effective base URL (OpenRouter defaults to its own endpoint when unset). */
  readonly baseUrl?: string;
  private client: OpenAI;
  private model: string;
  private reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | undefined;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.type === 'openrouter'
      ? (config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL)
      : config.baseUrl;
    this.client = new OpenAI({
      apiKey: resolveProviderApiKey(config),
      baseURL: this.baseUrl,
    });
    this.model = config.model;
    this.modelName = config.model;
    this.reasoningEffort = config.reasoningEffort;
  }

  private resolveReasoningEffort(): string | undefined {
    // Explicit config wins (stealth/ox-alpha needs 'low'; it rejects 'none').
    if (this.reasoningEffort !== undefined) {
      return this.reasoningEffort;
    }
    // Name heuristic for gpt-5/o-series on chat/completions (#13): tools are
    // rejected with any other effort, and the agent always sends tools.
    return isReasoningModel(this.model) ? 'none' : undefined;
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
    const effort = this.resolveReasoningEffort();
    if (effort !== undefined) {
      (params as ChatParamsWithReasoning).reasoning_effort = effort as 'none';
    }

    const completion = await this.client.chat.completions.create(params);
    const message = completion.choices[0].message;
    const usage = toTokenUsage(completion.usage);

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
    const imageEffort = this.resolveReasoningEffort();
    if (imageEffort !== undefined) {
      (imageParams as ChatParamsWithReasoning).reasoning_effort = imageEffort as 'none';
    }
    const completion = await this.client.chat.completions.create(imageParams);
    const message = completion.choices[0].message;
    const usage = toTokenUsage(completion.usage);

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
