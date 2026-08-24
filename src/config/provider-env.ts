import type { ProviderConfig } from './types';

export function providerEnvVar(providerType: ProviderConfig['type']): string | undefined {
  switch (providerType) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'google':
      return 'GOOGLE_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'ollama':
      return undefined;
  }
}
