// src/config/config.ts
//
// Pure configuration policy. This module performs NO filesystem access: decoding,
// defaulting, owner-path derivation and effective-config assembly all happen here, so
// the same rules apply to startup, setup, `config set` and local inspection.
//
// Disk IO lives in `src/runtime/adapters/config-file.ts` (bounded read, canonical
// resolution, commit-outcome reporting) and `src/runtime/installation.ts` (lease-owned
// writers). That split is what makes the config policy liftable and testable.

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

/**
 * Assemble the runtime configuration: the validated stored document plus the owner paths
 * resolved once by the caller. Nothing downstream re-derives a path.
 */
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

/**
 * Derive the three owner paths a config needs. `OwnerPaths` from `src/profiles/paths.ts`
 * structurally satisfies this, so this module does not import the profiles module.
 */
export function resolveEffectiveConfig(
  stored: StoredConfig,
  paths: DerivedOwnerPaths,
): EffectiveConfig {
  return effectiveFromStored(stored, paths);
}

/**
 * Decode a raw parsed document into a validated `StoredConfig`. Never throws for bad
 * input; the caller decides how to refuse.
 */
export function decodeConfigDocument(input: unknown, options: DecodeOptions = {}): ConfigDecodeResult {
  return decodeStoredConfig(input, { homeDir: options.homeDir ?? os.homedir() });
}

/** The single persisted form. Only the stored document is written to disk. */
export function serializeStoredConfig(stored: StoredConfig): string {
  return `${JSON.stringify(stored, null, 2)}\n`;
}

export { CONFIG_SCHEMA_VERSION };
export type { ConfigDecodeResult, DerivedOwnerPaths, EffectiveConfig, StoredConfig };
