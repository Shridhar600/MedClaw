// src/runtime/installation.ts
//
// The local writer/reader services that own the selected configuration document.
//
// T1 scope: strict read + honest commit reporting. T2 adds the resource leases and the
// `InstallationService` writer lifetime on top of exactly these primitives, so the
// ownership model has one place to live.
//
// Nothing here decides policy: decoding is `src/config`, bounded IO is
// `src/runtime/adapters/config-file.ts`, and selection is `src/runtime/startup.ts`.

import * as path from 'path';
import JSON5 from 'json5';
import { decodeConfigDocument, serializeStoredConfig } from '../config';
import { formatConfigIssue } from '../config/validation';
import type { EffectiveConfig, StoredConfig } from '../config';
import { asProfileId, derivedPathsFor, resolveOwnerPaths } from '../profiles';
import type { OwnerPaths, ProfileId } from '../profiles';
import { resolveEffectiveConfig } from '../config';
import {
  canonicalizeConfigPath,
  readConfigFile,
  writeConfigFile,
  type ConfigFileReason,
  type ConfigFileSync,
  type ConfigWriteOutcome,
} from './adapters/config-file';
import { ConfigUnavailableError, ONBOARD_GUIDANCE } from './startup';
import { secureMkdir } from '../security';
import type {
  LeaseBusy,
  LeaseUnavailableReason,
  ResourceLeasePort,
} from '../ports/resource-lease';

export interface LoadedConfigDocument {
  stored: StoredConfig;
  canonicalPath: string;
}

/**
 * Read and strictly decode the selected document. Every refusal keeps the original file
 * untouched and names an allowlisted reason.
 */
export function readConfigDocument(configPath: string, homeDir: string): LoadedConfigDocument {
  const read = readConfigFile(configPath);
  if (read.kind === 'missing') {
    throw new ConfigUnavailableError('missing', `Config file not found at ${configPath}. ${ONBOARD_GUIDANCE}`);
  }
  if (read.kind === 'unavailable') {
    throw new ConfigUnavailableError(
      read.reason,
      `Config file at ${configPath} is unusable (${read.reason}). ${ONBOARD_GUIDANCE}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(read.text);
  } catch {
    throw new ConfigUnavailableError(
      'invalid-document',
      `Config file at ${configPath} is not parseable JSON/JSON5. ${ONBOARD_GUIDANCE}`,
    );
  }

  const decoded = decodeConfigDocument(parsed, { homeDir });
  if (decoded.kind === 'invalid') {
    const detail = decoded.issues.map(formatConfigIssue).join('; ');
    throw new ConfigUnavailableError(
      'invalid-document',
      `Config file at ${configPath} was refused: ${detail}. ${ONBOARD_GUIDANCE}`,
    );
  }
  return { stored: decoded.config, canonicalPath: read.canonicalPath };
}

/** Assemble the effective configuration for an already-decoded stored document. */
export function effectiveConfigFor(stored: StoredConfig): EffectiveConfig {
  const ownerId = asProfileId(stored.profiles.defaultProfileId);
  if (ownerId === undefined) {
    throw new ConfigUnavailableError(
      'invalid-owner-id',
      'profiles.defaultProfileId is not a valid owner ID. Re-run setup.',
    );
  }
  return resolveEffectiveConfig(stored, derivedPathsFor(resolveOwnerPaths(stored.profiles.baseDir, ownerId)));
}

/**
 * Replace the document and report the real outcome. Never asserts the old bytes survived.
 *
 * Accepts either a caller-canonicalized path (a reader already resolved it) or a raw target
 * path (a fresh setup has no document yet); canonicalization happens here either way.
 */
export function writeConfigDocument(
  targetPath: string,
  stored: StoredConfig,
  options: { sync?: ConfigFileSync } = {},
): ConfigWriteOutcome {
  const { canonicalPath } = canonicalizeConfigPath(targetPath);
  return writeConfigFile(canonicalPath, serializeStoredConfig(stored), options);
}

/** Reason text for a refusal, safe to show in local CLI output. */
export function describeRefusal(reason: ConfigFileReason): string {
  switch (reason) {
    case 'missing':
      return 'no configuration document is selected';
    case 'too-large':
      return 'the configuration document exceeds the 256 KiB read limit';
    case 'unreadable':
      return 'the configuration document could not be read';
    case 'not-a-regular-file':
      return 'the configuration path is not a regular file';
    case 'hard-linked':
      return 'the configuration file has more than one hard link, so replacing it would leave aliases out of step';
    case 'unsafe-parent':
      return 'the configuration parent directory is not usable';
    case 'write-failed':
      return 'the replacement could not be written';
    case 'flush-failed':
      return 'the replacement was written but its durability could not be confirmed';
    case 'chmod-failed':
      return 'the replacement was written but its owner-only mode could not be confirmed';
    default:
      return 'the configuration document could not be used';
  }
}

export { writeConfigFile, readConfigFile, canonicalizeConfigPath };
export type { ConfigWriteOutcome, ConfigFileSync };

// ── Resource ownership ────────────────────────────────────────────────────────────────
// Installation is the composition root for local writers. The acquisition order is fixed and
// every supported writer follows it:
//
//   1. acquire the CONFIG lease, keyed on the canonical configuration path;
//   2. read and validate the configuration INSIDE that lease;
//   3. acquire the OWNER WORKSPACE lease for the selected owner;
//   4. on failure at (3), release only the lease this caller acquired at (1).
//
// No provider probe, model call, prompt wait or spawned daemon happens inside a critical section.
// A stale, unknown or malformed lease is always `busy` with operator guidance; nothing is ever
// cleared automatically and no TTL can steal ownership.

/** The two leases one caller holds, plus the identity they were acquired for. */
export interface InstallationOwnership {
  ownerId: ProfileId;
  ownerPaths: OwnerPaths;
  stored: StoredConfig;
  canonicalConfigPath: string;
  release(): Promise<void>;
}

export type OwnershipResult =
  | { kind: 'owned'; ownership: InstallationOwnership }
  | { kind: 'busy'; resource: 'config' | 'owner'; lease: LeaseBusy }
  | { kind: 'unavailable'; resource: 'config' | 'owner'; reason: LeaseUnavailableReason; guidance: string }
  | { kind: 'invalid-config'; message: string };

export class InstallationService {
  constructor(private readonly leases: ResourceLeasePort) {}

  /**
   * Take ownership of the selected configuration and the selected owner workspace.
   *
   * On success the caller holds both leases and MUST release them. On any failure nothing is
   * left held: the config lease is released before returning.
   */
  async acquireOwnership(configPath: string, homeDir: string): Promise<OwnershipResult> {
    const { canonicalPath } = canonicalizeConfigPath(configPath);

    const configLease = await this.leases.tryAcquire({ kind: 'config', canonicalPath });
    if (configLease.kind === 'busy') {
      return { kind: 'busy', resource: 'config', lease: configLease };
    }
    if (configLease.kind === 'unavailable') {
      return {
        kind: 'unavailable',
        resource: 'config',
        reason: configLease.reason,
        guidance: configLease.guidance,
      };
    }

    let stored: StoredConfig;
    try {
      ({ stored } = readConfigDocument(canonicalPath, homeDir));
    } catch (error) {
      await configLease.release();
      return {
        kind: 'invalid-config',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const ownerId = asProfileId(stored.profiles.defaultProfileId);
    if (ownerId === undefined) {
      await configLease.release();
      return {
        kind: 'invalid-config',
        message: 'profiles.defaultProfileId is not a valid owner ID. Re-run setup.',
      };
    }
    const ownerPaths = resolveOwnerPaths(stored.profiles.baseDir, ownerId);

    // Structural parents needed for the lease itself are created here, under the config lease.
    // Creating them grants no authority and never counts as pre-existing owner content.
    try {
      secureMkdir(path.dirname(ownerPaths.workspaceLease));
    } catch {
      await configLease.release();
      return {
        kind: 'unavailable',
        resource: 'owner',
        reason: 'unsafe-parent',
        guidance:
          'The owner workspace directory could not be created, so this installation cannot be owned. Check local permissions and retry.',
      };
    }

    const ownerLease = await this.leases.tryAcquire({
      kind: 'owner',
      canonicalPath: ownerPaths.workspace,
      leasePath: ownerPaths.workspaceLease,
    });
    if (ownerLease.kind === 'busy') {
      // Release ONLY the lease this caller acquired. The other holder's lease is untouched.
      await configLease.release();
      return { kind: 'busy', resource: 'owner', lease: ownerLease };
    }
    if (ownerLease.kind === 'unavailable') {
      await configLease.release();
      return {
        kind: 'unavailable',
        resource: 'owner',
        reason: ownerLease.reason,
        guidance: ownerLease.guidance,
      };
    }

    let released = false;
    return {
      kind: 'owned',
      ownership: {
        ownerId,
        ownerPaths,
        stored,
        canonicalConfigPath: canonicalPath,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          await ownerLease.release();
          await configLease.release();
        },
      },
    };
  }
}

/** Human-readable refusal for an ownership result, safe for local CLI output. */
export function describeOwnershipRefusal(result: OwnershipResult): string {
  switch (result.kind) {
    case 'owned':
      return '';
    case 'busy':
      return `Cannot start: ${result.lease.guidance}`;
    case 'unavailable':
      return `Cannot start: ${result.guidance}`;
    case 'invalid-config':
      return `Cannot start: ${result.message}`;
    default:
      return 'Cannot start: the installation could not be opened.';
  }
}
