import { spawn, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import type { AppConfig } from '../config/types';
import { validateConfig } from '../config/validation';
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

function usesOllama(config: AppConfig): boolean {
  return [config.providers.main, config.providers.medical, config.providers.embeddings]
    .some((provider) => provider.type === 'ollama');
}

function getOllamaBaseUrls(config: AppConfig): string[] {
  return [config.providers.main, config.providers.medical, config.providers.embeddings]
    .filter((provider) => provider.type === 'ollama')
    .map((provider) => provider.baseUrl?.trim() ?? '')
    .filter((baseUrl, index, all) => baseUrl.length > 0 && all.indexOf(baseUrl) === index);
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

  if (!config.channels.telegram.enabled && !config.heartbeat.enabled) {
    blockers.push('Nothing is enabled to keep MedClaw running. Enable Telegram or heartbeats before starting.');
  }

  if (!fs.existsSync(configPath)) {
    blockers.push(`Config file missing at ${configPath}.`);
  }
  if (!fs.existsSync(config.memory.workspace)) {
    blockers.push(`Workspace missing at ${config.memory.workspace}.`);
  }

  if (usesOllama(config)) {
    const combinedModels = new Set<string>();
    for (const baseUrl of getOllamaBaseUrls(config)) {
      const ollama = await ensureOllamaRuntime(baseUrl, dependencies);
      warnings.push(...ollama.warnings);
      blockers.push(...ollama.blockers);
      for (const model of ollama.models) {
        combinedModels.add(model);
      }
      if (ollama.reachable && ollama.autoStarted) {
        warnings.push(`Ollama was started automatically for ${baseUrl}.`);
      }
    }
    const missingModels = getMissingOllamaModels(getRequiredOllamaModels(config), [...combinedModels]);
    for (const model of missingModels) {
      blockers.push(`Missing Ollama model: ${model}. Run \`ollama pull ${model}\`.`);
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
