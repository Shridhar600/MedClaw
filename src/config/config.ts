
import * as os from 'os';
import {
  CONFIG_SCHEMA_VERSION,
  type DerivedOwnerPaths,
  type EffectiveConfig,
  type StoredConfig,
} from './types';
import { cloneStoredDefaults } from './defaults';
import { decodeStoredConfig, type ConfigDecodeResult } from './validation';

export interface DecodeOptions {
  homeDir?: string;
}

/** Defaults as a fresh mutable copy. Never returns the shared object. */
export function getDefaultConfig(): EffectiveConfig {
  return effectiveFromStored(cloneStoredDefaults(), defaultDerivedPaths());
}

function defaultDerivedPaths(): DerivedOwnerPaths {
  const home = os.homedir();
  return {
    workspace: `${home}/.redacted/profiles/default`,
    schedulerStorePath: `${home}/.redacted/profiles/default/.state/heartbeat-jobs.json`,
    auditLogPath: `${home}/.redacted/profiles/default/.state/audit.jsonl`,
  };
}

export function effectiveFromStored(stored: StoredConfig, paths: DerivedOwnerPaths): EffectiveConfig {
  return {
    ...structuredClone(stored),
    memory: { ...structuredClone(stored.memory), workspace: paths.workspace },
    heartbeat: {
      ...structuredClone(stored.heartbeat),
      storePath: paths.schedulerStorePath,
      audit: { path: paths.auditLogPath },
    },
  };
}

export function resolveEffectiveConfig(
  stored: StoredConfig,
  paths: DerivedOwnerPaths,
): EffectiveConfig {
  return effectiveFromStored(stored, paths);
}

export function decodeConfigDocument(input: unknown, options: DecodeOptions = {}): ConfigDecodeResult {
  return decodeStoredConfig(input, { homeDir: options.homeDir ?? os.homedir() });
}

/** The single persisted form. Only the stored document is written to disk. */
export function serializeStoredConfig(stored: StoredConfig): string {
  return `${JSON.stringify(stored, null, 2)}\n`;
}

export { CONFIG_SCHEMA_VERSION };
export type { ConfigDecodeResult, DerivedOwnerPaths, EffectiveConfig, StoredConfig };
