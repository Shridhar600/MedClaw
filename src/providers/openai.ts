import OpenAI from 'openai';
import type { ImageAttachment, LLMProvider, LLMResponse, Message, TokenUsage, ToolSchema } from './types';
import type { ProviderConfig } from '../config/types';
import { PROVIDER_REQUEST_TIMEOUT_MS, firstChoice, parseToolArguments } from './request';

// Reasoning models reject tools unless effort is 'none'; the agent always sends tools.
function isReasoningModel(model: string): boolean {
  return /^(?:gpt-5|o[1-9])/i.test(model);
}

type ReasoningEffort = NonNullable<ProviderConfig['reasoningEffort']>;

// The installed SDK types reasoning_effort without 'none'/'minimal', which the API accepts.
type ChatParamsWithReasoning =
  Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, 'reasoning_effort'> & { reasoning_effort?: ReasoningEffort };

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
  readonly baseUrl?: string;
  private client: OpenAI;
  private model: string;
  private reasoningEffort: ReasoningEffort | undefined;

  constructor(config: ProviderConfig, private readonly timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS) {
    this.baseUrl = config.type === 'openrouter'
      ? (config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL)
      : config.baseUrl;
    this.client = new OpenAI({
      apiKey: resolveProviderApiKey(config),
      baseURL: this.baseUrl,
      timeout: timeoutMs,
      maxRetries: 1,
    });
    this.model = config.model;
    this.modelName = config.model;
    this.reasoningEffort = config.reasoningEffort;
  }

  private resolveReasoningEffort(): ReasoningEffort | undefined {
    // Some models reject 'none', so explicit config wins.
    if (this.reasoningEffort !== undefined) {
      return this.reasoningEffort;
    }
    return isReasoningModel(this.model) ? 'none' : undefined;
  }

  async chat(messages: Message[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    };
    if (tools && tools.length > 0) {
      params.tools = tools as OpenAI.Chat.ChatCompletionTool[];
    }
    const effort = this.resolveReasoningEffort();
    if (effort !== undefined) {
      (params as ChatParamsWithReasoning).reasoning_effort = effort;
    }

    const completion = await this.client.chat.completions.create(params, this.requestOptions());
    const message = firstChoice(completion.choices).message;
    const usage = toTokenUsage(completion.usage);

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: 'tool_call',
        toolCalls: message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: parseToolArguments(tc.function.arguments),
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
      (imageParams as ChatParamsWithReasoning).reasoning_effort = imageEffort;
    }
    const completion = await this.client.chat.completions.create(imageParams, this.requestOptions());
    const message = firstChoice(completion.choices).message;
    const usage = toTokenUsage(completion.usage);

    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        type: 'tool_call',
        toolCalls: message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: parseToolArguments(tc.function.arguments),
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
    }, this.requestOptions());
    return firstChoice(result.data).embedding;
  }

  private requestOptions(): { signal: AbortSignal } {
    return { signal: AbortSignal.timeout(this.timeoutMs) };
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}
