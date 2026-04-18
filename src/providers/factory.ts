// src/providers/factory.ts
import type { ProviderConfig } from '../config/types';
import type { LLMProvider } from './types';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai':
    case 'anthropic': // Anthropic has OpenAI-compatible endpoint
    case 'google':
      return new OpenAIProvider(config);
    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = config.type;
      throw new Error(`Unknown provider type: ${String(_exhaustive)}`);
    }
  }
}
