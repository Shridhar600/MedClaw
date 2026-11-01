import type { ProviderConfig } from '../config/types';
import type { LLMProvider } from './types';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';

/**
 * Provider construction seam. Callers that own the lifecycle pass a factory in so a real runtime
 * can be built in tests without real providers; the default is the real `createProvider`.
 */
export type ProviderFactory = (config: ProviderConfig) => LLMProvider;

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai':
    case 'anthropic': // Anthropic has OpenAI-compatible endpoint
    case 'google':
    case 'openrouter': // OpenRouter is OpenAI-compatible; base URL defaults in OpenAIProvider
      return new OpenAIProvider(config);
    default: {
      // Exhaustiveness check.
      const _exhaustive: never = config.type;
      throw new Error(`Unknown provider type: ${String(_exhaustive)}`);
    }
  }
}
