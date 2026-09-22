// src/config/config.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSON5 from 'json5';
import type { AppConfig } from './types';
import { cloneDefaultConfig } from './defaults';
import { secureMkdir } from '../security';
import { BUILT_IN_EMERGENCY_KEYWORDS } from '../safety/emergency-detector';

export interface LoadConfigOptions {
  configPath?: string;
  requireFile?: boolean;
}

export function getDefaultConfig(): AppConfig {
  return cloneDefaultConfig();
}

function resolvePath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      typeof target[key] === 'object' &&
      target[key] !== null
    ) {
      result[key] = deepMerge(target[key] as object, sourceVal as object) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[keyof T];
    }
  }
  return result;
}

export async function loadConfig(configPath?: string): Promise<AppConfig>;
export async function loadConfig(options?: LoadConfigOptions): Promise<AppConfig>;
export async function loadConfig(input?: string | LoadConfigOptions): Promise<AppConfig> {
  const options = typeof input === 'string' ? { configPath: input } : input ?? {};
  const resolvedPath = options.configPath ?? path.join(os.homedir(), '.redacted', 'config.json');
  const defaults = getDefaultConfig();

  if (!fs.existsSync(resolvedPath)) {
    if (options.requireFile) {
      throw new Error(
        `Config file not found at ${resolvedPath}. Run \`npm run cli -- onboard\` to create one, or pass --config with an existing config path.`,
      );
    }
    console.warn(`[config] No config file at ${resolvedPath}, using defaults`);
    return defaults;
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const userConfig = JSON5.parse(raw) as Partial<AppConfig>;
  const merged = deepMerge(defaults, userConfig);
  merged.emergency = {
    keywords: [...new Set([
      ...BUILT_IN_EMERGENCY_KEYWORDS,
      ...(Array.isArray(userConfig.emergency?.keywords) ? userConfig.emergency.keywords : []),
    ])],
  };
  removeDefaultBaseUrlForCloudProviders(merged, userConfig);

  // Resolve ~ in paths
  merged.memory.workspace = resolvePath(merged.memory.workspace);
  merged.heartbeat.storePath = resolvePath(merged.heartbeat.storePath);
  merged.heartbeat.audit!.path = resolvePath(merged.heartbeat.audit!.path);
  merged.profiles!.baseDir = resolvePath(merged.profiles!.baseDir);

  return merged;
}

function removeDefaultBaseUrlForCloudProviders(config: AppConfig, userConfig: Partial<AppConfig>): void {
  for (const key of ['main', 'medical', 'embeddings'] as const) {
    const provider = config.providers[key];
    const userProvider = userConfig.providers?.[key];
    if (provider.type !== 'ollama' && userProvider?.baseUrl === undefined) {
      delete provider.baseUrl;
    }
  }
}

export async function saveConfig(configPath: string, config: AppConfig): Promise<void> {
  secureMkdir(path.dirname(configPath));
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  const existingMode = fs.existsSync(configPath) ? fs.statSync(configPath).mode & 0o777 : 0o600;
  const finalMode = existingMode & 0o600;

  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  fs.chmodSync(configPath, finalMode);
}
