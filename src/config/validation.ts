import type { AppConfig, ProviderConfig } from './types';

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const SECRET_KEYS = new Set(['apiKey', 'botToken']);

export function redactConfig<T>(value: T): T {
  return redactValue(value) as T;
}

export function validateConfig(config: AppConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  validateProvider('providers.main', config.providers.main, errors);
  validateProvider('providers.medical', config.providers.medical, errors);
  validateProvider('providers.embeddings', config.providers.embeddings, errors);

  if (config.channels.telegram.enabled && !config.channels.telegram.botToken.trim()) {
    errors.push('channels.telegram.botToken is required when Telegram is enabled');
  }

  if (!config.memory.workspace.trim()) {
    errors.push('memory.workspace is required');
  }
  if (!config.heartbeat.timezone.trim()) {
    errors.push('heartbeat.timezone is required');
  }
  if (config.providers.main.type !== 'ollama' && !config.providers.main.apiKey?.trim()) {
    warnings.push('providers.main.apiKey is empty; runtime may require an environment-provided key');
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateProvider(label: string, provider: ProviderConfig, errors: string[]): void {
  if (!provider.model.trim()) {
    errors.push(`${label}.model is required`);
  }
  if (provider.type === 'ollama' && !provider.baseUrl?.trim()) {
    errors.push(`${label}.baseUrl is required for Ollama providers`);
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = SECRET_KEYS.has(key) && typeof nested === 'string' && nested.length > 0
        ? '[REDACTED]'
        : redactValue(nested);
    }
    return result;
  }
  return value;
}
