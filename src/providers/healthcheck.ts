import type { AppConfig, ProviderConfig } from '../config/types';

export interface ReadinessResult {
  ready: boolean;
  checked: boolean;
  label: string;
  details: string[];
  warnings: string[];
}

export interface HealthcheckOptions {
  allowNetworkChecks?: boolean;
  timeoutMs?: number;
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

async function probeUrl(url: string, timeoutMs: number): Promise<boolean> {
  if (typeof fetch !== 'function') {
    return false;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: 'GET', signal: controller.signal });
      return response.ok || response.status < 500;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

export async function checkProviderReadiness(
  label: string,
  provider: ProviderConfig,
  options: HealthcheckOptions = {},
): Promise<ReadinessResult> {
  const details: string[] = [];
  const warnings: string[] = [];
  let ready = true;

  if (!provider.model.trim()) {
    ready = false;
    details.push('missing model');
  }
  if (provider.type === 'ollama' && !provider.baseUrl?.trim()) {
    ready = false;
    details.push('missing baseUrl');
  }
  if (provider.type !== 'ollama' && !provider.apiKey?.trim()) {
    warnings.push('apiKey is not configured');
  }

  const baseUrl = safeUrl(provider.baseUrl);
  const allowNetworkChecks = options.allowNetworkChecks ?? false;
  if (allowNetworkChecks && baseUrl) {
    const reachable = await probeUrl(baseUrl, options.timeoutMs ?? 1500);
    if (!reachable) {
      warnings.push('network probe skipped or failed');
    }
  } else if (allowNetworkChecks && provider.baseUrl && !baseUrl) {
    warnings.push('baseUrl is not a valid URL');
  } else {
    warnings.push('network probe skipped');
  }

  return {
    ready,
    checked: allowNetworkChecks,
    label,
    details,
    warnings,
  };
}

export async function checkTelegramReadiness(
  config: AppConfig,
  options: HealthcheckOptions = {},
): Promise<ReadinessResult> {
  const enabled = config.channels.telegram.enabled;
  const token = config.channels.telegram.botToken.trim();
  const details: string[] = [];
  const warnings: string[] = [];
  let ready = true;

  if (!enabled) {
    details.push('disabled');
    return { ready: true, checked: false, label: 'telegram', details, warnings };
  }

  if (!token) {
    ready = false;
    details.push('missing bot token');
    return { ready, checked: false, label: 'telegram', details, warnings };
  }

  const allowNetworkChecks = options.allowNetworkChecks ?? false;
  if (allowNetworkChecks) {
    const url = `https://api.telegram.org/bot${token}/getMe`;
    const reachable = await probeUrl(url, options.timeoutMs ?? 1500);
    if (!reachable) {
      warnings.push('network probe skipped or failed');
    }
  } else {
    warnings.push('network probe skipped');
  }

  return {
    ready,
    checked: allowNetworkChecks,
    label: 'telegram',
    details,
    warnings,
  };
}

export async function checkSystemReadiness(
  config: AppConfig,
  options: HealthcheckOptions = {},
): Promise<{ providers: ReadinessResult[]; telegram: ReadinessResult }> {
  return {
    providers: [
      await checkProviderReadiness('main provider', config.providers.main, options),
      await checkProviderReadiness('medical provider', config.providers.medical, options),
      await checkProviderReadiness('embeddings provider', config.providers.embeddings, options),
    ],
    telegram: await checkTelegramReadiness(config, options),
  };
}
