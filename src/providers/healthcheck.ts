import type { AppConfig, ProviderConfig } from '../config/types';

export type ReadinessStatus = 'ok' | 'warn' | 'fail';

export interface ReadinessResult {
  ready: boolean;
  checked: boolean;
  label: string;
  status: ReadinessStatus;
  details: string[];
  warnings: string[];
  reasonCode?: string;
  actionHint?: string;
}

export interface HealthcheckOptions {
  allowNetworkChecks?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OllamaCatalogProbe {
  checked: boolean;
  reachable: boolean;
  status: ReadinessStatus;
  details: string[];
  warnings: string[];
  models: string[];
  version?: string;
  reasonCode?: string;
  actionHint?: string;
}

interface JsonProbeResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

function providerEnvVar(providerType: ProviderConfig['type']): string | undefined {
  switch (providerType) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'google':
      return 'GOOGLE_API_KEY';
    case 'ollama':
      return undefined;
  }
}

function getFetchImpl(options: HealthcheckOptions): typeof fetch | undefined {
  return options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
}

function safeUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function deriveOllamaRoot(baseUrl: string): URL | undefined {
  const parsed = safeUrl(baseUrl);
  if (!parsed) {
    return undefined;
  }
  return new URL('/', parsed);
}

async function probeJson(url: string, options: HealthcheckOptions): Promise<JsonProbeResult> {
  const fetchImpl = getFetchImpl(options);
  if (!fetchImpl) {
    return {
      ok: false,
      status: 0,
      error: 'fetch unavailable',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getOllamaModelNames(body: unknown): string[] {
  if (!body || typeof body !== 'object') {
    return [];
  }

  const models = (body as { models?: Array<{ name?: string }> }).models;
  if (!Array.isArray(models)) {
    return [];
  }

  return models
    .map((model) => model?.name?.trim())
    .filter((name): name is string => Boolean(name));
}

export async function probeOllamaCatalog(
  baseUrl: string | undefined,
  options: HealthcheckOptions = {},
): Promise<OllamaCatalogProbe> {
  const root = baseUrl ? deriveOllamaRoot(baseUrl) : undefined;
  if (!root) {
    return {
      checked: false,
      reachable: false,
      status: 'fail',
      details: ['invalid Ollama URL'],
      warnings: [],
      models: [],
      reasonCode: 'invalid-url',
      actionHint: 'Set a valid Ollama URL before continuing.',
    };
  }

  const allowNetworkChecks = options.allowNetworkChecks ?? false;
  if (!allowNetworkChecks) {
    return {
      checked: false,
      reachable: false,
      status: 'warn',
      details: [`configured: ${root.toString().replace(/\/$/, '')}`],
      warnings: ['network verification skipped'],
      models: [],
    };
  }

  const versionProbe = await probeJson(new URL('api/version', root).toString(), options);
  const tagsProbe = await probeJson(new URL('api/tags', root).toString(), options);

  if (versionProbe.error || tagsProbe.error) {
    return {
      checked: true,
      reachable: false,
      status: 'fail',
      details: ['Ollama is not reachable'],
      warnings: [],
      models: [],
      reasonCode: 'unreachable',
      actionHint: 'Run `ollama serve` and retry.',
    };
  }

  if (versionProbe.status === 404 || tagsProbe.status === 404) {
    return {
      checked: true,
      reachable: false,
      status: 'fail',
      details: ['endpoint did not respond like Ollama'],
      warnings: [],
      models: [],
      reasonCode: 'not-ollama',
      actionHint: 'Check the Ollama URL and confirm the Ollama server is running.',
    };
  }

  if (!versionProbe.ok || !tagsProbe.ok) {
    return {
      checked: true,
      reachable: false,
      status: 'fail',
      details: [`unexpected response from Ollama (${tagsProbe.status || versionProbe.status})`],
      warnings: [],
      models: [],
      reasonCode: 'bad-response',
      actionHint: 'Check the Ollama server and configured URL.',
    };
  }

  return {
    checked: true,
    reachable: true,
    status: 'ok',
    details: ['Ollama reachable'],
    warnings: [],
    models: getOllamaModelNames(tagsProbe.body),
    version:
      typeof versionProbe.body === 'object' &&
      versionProbe.body !== null &&
      'version' in versionProbe.body &&
      typeof (versionProbe.body as { version?: unknown }).version === 'string'
        ? (versionProbe.body as { version: string }).version
        : undefined,
  };
}

export async function verifyTelegramToken(
  token: string,
  options: HealthcheckOptions = {},
): Promise<ReadinessResult> {
  if (!token.trim()) {
    return {
      ready: false,
      checked: false,
      label: 'telegram',
      status: 'fail',
      details: ['missing bot token'],
      warnings: [],
      reasonCode: 'missing-token',
      actionHint: 'Provide a Telegram bot token or disable Telegram.',
    };
  }

  const allowNetworkChecks = options.allowNetworkChecks ?? false;
  if (!allowNetworkChecks) {
    return {
      ready: true,
      checked: false,
      label: 'telegram',
      status: 'warn',
      details: ['token configured'],
      warnings: ['verification skipped'],
    };
  }

  const probe = await probeJson(`https://api.telegram.org/bot${token}/getMe`, options);
  const body = probe.body as { ok?: boolean; description?: string; result?: { username?: string } } | undefined;

  if (probe.error) {
    return {
      ready: true,
      checked: true,
      label: 'telegram',
      status: 'warn',
      details: ['token configured'],
      warnings: ['network verification failed'],
      reasonCode: 'network-error',
      actionHint: 'Check your connection and retry Telegram verification.',
    };
  }

  if (probe.status === 401 || body?.ok === false) {
    return {
      ready: false,
      checked: true,
      label: 'telegram',
      status: 'fail',
      details: [body?.description?.trim() || 'token rejected by Telegram'],
      warnings: [],
      reasonCode: 'invalid-token',
      actionHint: 'Paste a valid Telegram bot token.',
    };
  }

  if (!probe.ok || body?.ok !== true) {
    return {
      ready: true,
      checked: true,
      label: 'telegram',
      status: 'warn',
      details: ['token configured'],
      warnings: ['verification returned an unexpected response'],
      reasonCode: 'unexpected-response',
      actionHint: 'Retry verification after checking the Telegram endpoint.',
    };
  }

  const username = body.result?.username ? `@${body.result.username}` : 'bot verified';
  return {
    ready: true,
    checked: true,
    label: 'telegram',
    status: 'ok',
    details: [`verified: ${username}`],
    warnings: [],
  };
}

async function checkOllamaProviderReadiness(
  label: string,
  provider: ProviderConfig,
  options: HealthcheckOptions = {},
): Promise<ReadinessResult> {
  const details: string[] = [];
  const warnings: string[] = [];

  if (!provider.model.trim()) {
    return {
      ready: false,
      checked: false,
      label,
      status: 'fail',
      details: ['missing model'],
      warnings,
      reasonCode: 'missing-model',
      actionHint: 'Choose a model before continuing.',
    };
  }

  if (!provider.baseUrl?.trim()) {
    return {
      ready: false,
      checked: false,
      label,
      status: 'fail',
      details: ['missing baseUrl'],
      warnings,
      reasonCode: 'missing-base-url',
      actionHint: 'Provide an Ollama URL before continuing.',
    };
  }

  const catalog = await probeOllamaCatalog(provider.baseUrl, options);
  details.push(...catalog.details);
  warnings.push(...catalog.warnings);

  if (!catalog.checked) {
    return {
      ready: true,
      checked: false,
      label,
      status: 'warn',
      details: [...details, `model configured: ${provider.model}`],
      warnings,
    };
  }

  if (!catalog.reachable) {
    return {
      ready: false,
      checked: catalog.checked,
      label,
      status: catalog.status,
      details,
      warnings,
      reasonCode: catalog.reasonCode,
      actionHint: catalog.actionHint,
    };
  }

  if (!catalog.models.includes(provider.model)) {
    return {
      ready: false,
      checked: catalog.checked,
      label,
      status: 'fail',
      details: [...details, `model not installed: ${provider.model}`],
      warnings,
      reasonCode: 'missing-model',
      actionHint: `Run \`ollama pull ${provider.model}\` and retry.`,
    };
  }

  return {
    ready: true,
    checked: catalog.checked,
    label,
    status: warnings.length > 0 ? 'warn' : 'ok',
    details: [...details, `model installed: ${provider.model}`],
    warnings,
  };
}

export async function checkProviderReadiness(
  label: string,
  provider: ProviderConfig,
  options: HealthcheckOptions = {},
): Promise<ReadinessResult> {
  if (provider.type === 'ollama') {
    return checkOllamaProviderReadiness(label, provider, options);
  }

  const details: string[] = [];
  const warnings: string[] = [];

  if (!provider.model.trim()) {
    return {
      ready: false,
      checked: false,
      label,
      status: 'fail',
      details: ['missing model'],
      warnings,
      reasonCode: 'missing-model',
      actionHint: 'Choose a model before continuing.',
    };
  }
  const envVar = providerEnvVar(provider.type);
  const hasApiKey = Boolean(provider.apiKey?.trim() || (envVar && process.env[envVar]?.trim()));
  if (!hasApiKey) {
    warnings.push('apiKey is not configured');
  } else {
    details.push('api key configured');
  }

  const baseUrl = safeUrl(provider.baseUrl);
  const allowNetworkChecks = options.allowNetworkChecks ?? false;
  if (allowNetworkChecks && provider.baseUrl && !baseUrl) {
    return {
      ready: false,
      checked: true,
      label,
      status: 'fail',
      details: ['baseUrl is not a valid URL'],
      warnings,
      reasonCode: 'invalid-url',
      actionHint: 'Set a valid provider URL or leave it empty to use the default endpoint.',
    };
  }

  if (!allowNetworkChecks) {
    warnings.push('network verification skipped');
  }

  return {
    ready: hasApiKey,
    checked: allowNetworkChecks,
    label,
    status: warnings.length > 0 ? 'warn' : 'ok',
    details: details.length > 0 ? details : ['configured'],
    warnings,
  };
}

export async function checkTelegramReadiness(
  config: AppConfig,
  options: HealthcheckOptions = {},
): Promise<ReadinessResult> {
  if (!config.channels.telegram.enabled) {
    return {
      ready: true,
      checked: false,
      label: 'telegram',
      status: 'ok',
      details: ['disabled'],
      warnings: [],
    };
  }

  return verifyTelegramToken(config.channels.telegram.botToken.trim(), options);
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
