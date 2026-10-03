// src/providers/factory.ts
import type { ProviderConfig } from '../config/types';
import type { LLMProvider } from './types';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';

/**
 * Provider construction seam (plan 15 §3).
 *
 * `ProfileRuntime.create` used to call `createProvider` itself for embeddings and medical, which
 * made it impossible to build a REAL runtime in a test without constructing real providers. Callers
 * that own the lifecycle pass a factory in; the default is the real one, so production behaviour is
 * unchanged and the seam is never a silent substitute for the genuine thing.
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
      // TypeScript exhaustiveness check
      const _exhaustive: never = config.type;
      throw new Error(`Unknown provider type: ${String(_exhaustive)}`);
    }
  }
}
