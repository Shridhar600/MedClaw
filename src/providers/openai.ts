// src/providers/openai.ts
import OpenAI from 'openai';
import type { LLMProvider, LLMResponse, Message, ToolSchema } from './types';
import type { ProviderConfig } from '../config/types';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: config.baseUrl,
    });
    this.model = config.model;
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

  async embed(text: string): Promise<number[]> {
    const result = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return result.data[0].embedding;
  }
}
