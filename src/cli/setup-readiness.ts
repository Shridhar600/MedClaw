import { spawn, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import type { AppConfig } from '../config/types';
import { validateConfig } from '../config/validation';
import { providerEnvVar } from '../config/provider-env';
import { probeOllamaCatalog, verifyTelegramToken, type HealthcheckOptions } from '../providers/healthcheck';

export interface SetupReadinessDependencies extends Pick<HealthcheckOptions, 'fetchImpl' | 'timeoutMs'> {
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    on: (event: 'error' | 'exit', listener: (...args: unknown[]) => void) => unknown;
    unref?: () => void;
    pid?: number;
  };
  sleep?: (ms: number) => Promise<void>;
}

export interface OllamaRuntimeCheck {
  reachable: boolean;
  autoStarted: boolean;
  models: string[];
  warnings: string[];
  blockers: string[];
}

export interface TelegramRuntimeCheck {
  verified: boolean;
  warnings: string[];
  blockers: string[];
}

export interface StartPreflightReport {
  ready: boolean;
  warnings: string[];
  blockers: string[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configuredProviders(config: AppConfig): Array<{
  label: 'providers.main' | 'providers.medical' | 'providers.embeddings';
  provider: AppConfig['providers']['main'];
}> {
  return [
    { label: 'providers.main', provider: config.providers.main },
    { label: 'providers.medical', provider: config.providers.medical },
    { label: 'providers.embeddings', provider: config.providers.embeddings },
  ];
}

function hasProviderApiKey(provider: AppConfig['providers']['main']): boolean {
  const envVar = providerEnvVar(provider.type);
  return Boolean(provider.apiKey?.trim() || (envVar && process.env[envVar]?.trim()));
}

function providerDisplayName(provider: AppConfig['providers']['main']): string {
  switch (provider.type) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'google':
      return 'Google';
    case 'openrouter':
      return 'OpenRouter';
    case 'ollama':
      return 'Ollama';
  }
}

export async function ensureOllamaRuntime(
  baseUrl: string | undefined,
  dependencies: SetupReadinessDependencies = {},
): Promise<OllamaRuntimeCheck> {
  const initial = await probeOllamaCatalog(baseUrl, {
    allowNetworkChecks: true,
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.timeoutMs,
  });

  if (initial.reachable) {
    return {
      reachable: true,
      autoStarted: false,
      models: initial.models,
      warnings: [],
      blockers: [],
    };
  }

  const spawnProcess = dependencies.spawnProcess ?? spawn;
  let spawnError: string | undefined;

  try {
    const child = spawnProcess('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
    });
    child.unref?.();
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  }

  const sleep = dependencies.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(500);
    const probe = await probeOllamaCatalog(baseUrl, {
      allowNetworkChecks: true,
      fetchImpl: dependencies.fetchImpl,
      timeoutMs: dependencies.timeoutMs,
    });
    if (probe.reachable) {
      return {
        reachable: true,
        autoStarted: true,
        models: probe.models,
        warnings: [],
        blockers: [],
      };
    }
  }

  return {
    reachable: false,
    autoStarted: false,
    models: [],
    warnings: spawnError ? [`Failed to auto-start Ollama: ${spawnError}`] : [],
    blockers: ['Ollama is not reachable. Run `ollama serve` and retry.'],
  };
}

export function getRequiredOllamaModels(config: AppConfig): string[] {
  return [config.providers.main, config.providers.medical, config.providers.embeddings]
    .filter((provider) => provider.type === 'ollama')
    .map((provider) => provider.model.trim())
    .filter((model, index, all) => model.length > 0 && all.indexOf(model) === index);
}

export function getMissingOllamaModels(requiredModels: string[], availableModels: string[]): string[] {
  const available = new Set(availableModels);
  return requiredModels.filter((model) => !available.has(model));
}

export async function verifyTelegramRuntime(
  config: AppConfig,
  dependencies: SetupReadinessDependencies = {},
): Promise<TelegramRuntimeCheck> {
  if (!config.channels.telegram.enabled) {
    return { verified: true, warnings: [], blockers: [] };
  }

  const result = await verifyTelegramToken(config.channels.telegram.botToken, {
    allowNetworkChecks: true,
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: dependencies.timeoutMs,
  });

  if (result.status === 'fail') {
    return {
      verified: false,
      warnings: [],
      blockers: [result.details[0] ?? 'Telegram token verification failed.'],
    };
  }

  return {
    verified: result.status === 'ok',
    warnings: result.warnings,
    blockers: [],
  };
}

export async function preflightStartCheck(
  config: AppConfig,
  configPath: string,
  dependencies: SetupReadinessDependencies = {},
): Promise<StartPreflightReport> {
  const blockers = [...validateConfig(config).errors];
  const warnings: string[] = [];
  const ollamaCatalogs = new Map<string, Promise<OllamaRuntimeCheck>>();
  const reportedOllamaUrls = new Set<string>();

  if (!config.channels.telegram.enabled && !config.heartbeat.enabled) {
    blockers.push('Nothing is enabled to keep MedClaw running. Enable Telegram or heartbeats before starting.');
  }

  if (!fs.existsSync(configPath)) {
    blockers.push(`Config file missing at ${configPath}.`);
  } else if (!fs.statSync(configPath).isFile()) {
    blockers.push(`Config path is not a file at ${configPath}.`);
  }
  if (!fs.existsSync(config.memory.workspace)) {
    blockers.push(`Workspace missing at ${config.memory.workspace}.`);
  } else if (!fs.statSync(config.memory.workspace).isDirectory()) {
    blockers.push(`Workspace path is not a directory at ${config.memory.workspace}.`);
  }

  for (const { label, provider } of configuredProviders(config)) {
    if (provider.type !== 'ollama') {
      if (!hasProviderApiKey(provider)) {
        const envVar = providerEnvVar(provider.type);
        const envHint = envVar ? ` Set apiKey or ${envVar}.` : ' Set apiKey.';
        blockers.push(`${label} apiKey is required for ${providerDisplayName(provider)} provider.${envHint}`);
      }
      continue;
    }

    const baseUrl = provider.baseUrl?.trim();
    if (!baseUrl || !provider.model.trim()) {
      continue;
    }

    if (!ollamaCatalogs.has(baseUrl)) {
      ollamaCatalogs.set(baseUrl, ensureOllamaRuntime(baseUrl, dependencies));
    }

    const ollama = await ollamaCatalogs.get(baseUrl)!;
    if (!reportedOllamaUrls.has(baseUrl)) {
      warnings.push(...ollama.warnings);
      blockers.push(...ollama.blockers);
      if (ollama.reachable && ollama.autoStarted) {
        warnings.push(`Ollama was started automatically for ${baseUrl}.`);
      }
      reportedOllamaUrls.add(baseUrl);
    }

    if (ollama.reachable && !ollama.models.includes(provider.model)) {
      blockers.push(
        `Missing Ollama model for ${label} at ${baseUrl}: ${provider.model}. Run \`ollama pull ${provider.model}\` against that endpoint.`,
      );
    }
  }

  const telegram = await verifyTelegramRuntime(config, dependencies);
  warnings.push(...telegram.warnings);
  blockers.push(...telegram.blockers);

  return {
    ready: blockers.length === 0,
    warnings,
    blockers,
  };
}
