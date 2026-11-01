
// Lease order is CONFIG then OWNER WORKSPACE, and a stale/unknown/malformed lease is busy, never auto-cleared.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSON5 from 'json5';
import { decodeConfigDocument, serializeStoredConfig, toStoredView } from '../config';
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
import { ensureWorkspaceBootstrap } from '../workspace/bootstrap';
import type { OwnerStatePort } from '../ports/owner-state';
import type { InitializeResult } from '../profiles';
import type {
  LeaseAcquired,
  LeaseBusy,
  LeaseUnavailableReason,
  ResourceLeasePort,
} from '../ports/resource-lease';

/** How the owner record store is built for one setup. Production uses the real file adapter. */
export type OwnerStateStoreFactory = (ownerRecordPath: string, ownerId: ProfileId) => OwnerStatePort;

/** Optional setup inputs. Production passes none; a test supplies a store or nothing else changes. */
export interface InstallationServiceOptions {
  ownerStore?: OwnerStateStoreFactory;
}

export interface LoadedConfigDocument {
  stored: StoredConfig;
  canonicalPath: string;
}

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

/** What a fresh install commits. The identity is prospective because no document exists to read. */
export interface SetupInput {
  configPath: string;
  /** The owner identity being created. Setup cannot read one from a document that does not exist. */
  ownerId: ProfileId;
  /** The configuration to validate and commit. */
  config: EffectiveConfig;
}

export type SetupResult =
  | { kind: 'committed'; canonicalConfigPath: string; ownerPaths: OwnerPaths }
  | { kind: 'busy'; resource: 'config' | 'owner'; lease: LeaseBusy }
  | { kind: 'unavailable'; resource: 'config' | 'owner'; reason: LeaseUnavailableReason; guidance: string }
  | { kind: 'not-fresh'; message: string }
  | { kind: 'incomplete'; message: string };

export function assertFreshInstallation(
  configPath: string,
  ownerRecordPath: string,
  workspace: string,
  workspaceLease?: string,
): string | undefined {
  if (fs.existsSync(configPath)) {
    return (
      `Setup refused: a configuration already exists at ${configPath}. `
      + 'Setup never overwrites an installation. Choose a fresh --config and/or --state-root target.'
    );
  }
  if (fs.existsSync(ownerRecordPath)) {
    return (
      `Setup refused: an owner record already exists at ${ownerRecordPath}. `
      + 'Setup never overwrites an installation. Choose a fresh --state-root target.'
    );
  }
  if (workspaceHasOwnerContent(workspace, workspaceLease)) {
    return (
      `Setup refused: the owner workspace ${workspace} is not empty. `
      + 'Existing owner evidence is never removed. Choose a fresh --state-root target.'
    );
  }
  return undefined;
}

/** Entries in `directory`, excluding `exclude` (compared on resolved absolute paths). */
function entriesExcept(directory: string, exclude?: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (exclude === undefined) return entries;
  const excluded = path.resolve(exclude);
  return entries.filter((entry) => path.resolve(directory, entry) !== excluded);
}

function workspaceHasOwnerContent(workspace: string, workspaceLease?: string): boolean {
  if (workspaceLease === undefined) return directoryHasEntries(workspace);

  const leaseDir = path.dirname(workspaceLease);
  const outsideLeaseDir = entriesExcept(workspace, leaseDir);
  if (outsideLeaseDir.length > 0) return true;

  // The lease directory itself must contain the lease and nothing else.
  return entriesExcept(leaseDir, workspaceLease).length > 0;
}

function directoryHasEntries(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

type StructuralScaffold = { ok: true } | { ok: false; reason: LeaseUnavailableReason; guidance: string };

function scaffoldStructuralParents(target: string): StructuralScaffold {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    if (directoryExists(current)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(current);
    current = parent;
  }

  for (const directory of missing) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          ok: false,
          reason: 'unsafe-parent',
          guidance:
            'The configuration directory cannot be owned because a path component is not a directory. Choose a different --config or --state-root target.',
        };
      }
      return {
        ok: false,
        reason: 'permission',
        guidance:
          'The configuration directory could not be created, so this installation cannot be owned. Check local permissions and retry.',
      };
    }
    try {
      fs.chmodSync(directory, 0o700);
    } catch { /* best-effort */ }
  }
  return { ok: true };
}

function directoryExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** What one attempt to create the required owner record achieved, plus what a readback can see. */
interface OwnerRecordAttempt {
  result: InitializeResult;
  /** A fresh read of the record AFTER the attempt. Only meaningful for a non-`created` result. */
  readable: boolean;
}

async function createUnpairedOwnerRecord(
  ownerRecordPath: string,
  ownerId: ProfileId,
  ownerStore: OwnerStateStoreFactory | undefined,
): Promise<OwnerRecordAttempt> {
  const { FileOwnerStatePort } = await import('./adapters/owner-state-file');
  const { CryptoPairingCodePort } = await import('./adapters/pairing-code');
  const { OwnerAdmissionService } = await import('../profiles');
  const { systemClock } = await import('../ports/defaults');

  const service = new OwnerAdmissionService({
    store: ownerStore ? ownerStore(ownerRecordPath, ownerId) : new FileOwnerStatePort(ownerRecordPath, ownerId),
    codes: new CryptoPairingCodePort(),
    clock: systemClock,
    expectedOwnerId: ownerId,
  });
  const result = await service.initialize();
  return {
    result,
    // An unconfirmed publication still needs real evidence about what an operator will find on disk.
    readable: result === 'uncertain' && service.inspectInstallation().kind !== 'refused',
  };
}

export class InstallationService {
  constructor(
    private readonly leases: ResourceLeasePort,
    private readonly options: InstallationServiceOptions = {},
  ) {}

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

  async setup(input: SetupInput): Promise<SetupResult> {
    const { config: configToPersist, ownerId } = input;
    const { canonicalPath } = canonicalizeConfigPath(input.configPath);

    const scaffolded = scaffoldStructuralParents(path.dirname(canonicalPath));
    if (!scaffolded.ok) {
      return {
        kind: 'unavailable',
        resource: 'config',
        reason: scaffolded.reason,
        guidance: scaffolded.guidance,
      };
    }

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

    const ownerPaths = resolveOwnerPaths(configToPersist.profiles.baseDir, ownerId);
    let ownerLease: LeaseAcquired | undefined;
    try {
      const stored = toStoredView(configToPersist);

      const decoded = decodeConfigDocument(stored, { homeDir: os.homedir() });
      if (decoded.kind === 'invalid') {
        return {
          kind: 'not-fresh',
          message: `Setup refused: the configuration is not valid and was not written. ${decoded.issues
            .map((issue) => `${issue.field}: ${issue.detail}`)
            .join('; ')}`,
        };
      }

      secureMkdir(path.dirname(ownerPaths.workspaceLease));

      const acquired = await this.leases.tryAcquire({
        kind: 'owner',
        canonicalPath: ownerPaths.workspace,
        leasePath: ownerPaths.workspaceLease,
      });
      if (acquired.kind === 'busy') {
        return { kind: 'busy', resource: 'owner', lease: acquired };
      }
      if (acquired.kind === 'unavailable') {
        return {
          kind: 'unavailable',
          resource: 'owner',
          reason: acquired.reason,
          guidance: acquired.guidance,
        };
      }

      ownerLease = acquired;

      const freshness = assertFreshInstallation(
        canonicalPath,
        ownerPaths.ownerRecord,
        ownerPaths.workspace,
        ownerPaths.workspaceLease,
      );
      if (freshness !== undefined) return { kind: 'not-fresh', message: freshness };

      ensureWorkspaceBootstrap(ownerPaths.workspace, { preserveExisting: true });
      secureMkdir(path.dirname(ownerPaths.schedulerStore));

      const attempt = await createUnpairedOwnerRecord(ownerPaths.ownerRecord, ownerId, this.options.ownerStore);
      const record = attempt.result;
      if (record !== 'created') {
        if (record === 'uncertain') {
          return {
            kind: 'incomplete',
            message:
              `Setup could not confirm the owner record at ${ownerPaths.ownerRecord}. `
              + (attempt.readable
                ? 'A record is present and readable; its durability could not be confirmed. '
                : 'The owner record could not be read back, so setup cannot say whether it was published. ')
              + 'No configuration document was written. Setup never overwrites or repairs an installation, '
              + 'so re-running it into this target is refused: inspect that record, and choose a fresh '
              + '--state-root target if you want a clean installation.',
          };
        }
        if (record === 'refused') {
          return {
            kind: 'incomplete',
            message:
              `Setup could not create the owner record at ${ownerPaths.ownerRecord} (${record}). `
              + 'No configuration document was written, and the owner workspace that setup created is left in place. '
              + 'Setup never overwrites or repairs a workspace, so re-running it into this target is refused: '
              + 'check local permissions and disk space, then choose a fresh --state-root target.',
          };
        }
        return {
          kind: 'not-fresh',
          message:
            `Setup refused: the owner record at ${ownerPaths.ownerRecord} could not be created (${record}). `
            + 'Setup never overwrites or repairs an existing installation. Choose a fresh --state-root target.',
        };
      }

      const outcome = writeConfigDocument(canonicalPath, stored);
      if (outcome.status === 'failed') {
        return {
          kind: 'incomplete',
          message:
            'Setup could not write the configuration document; the workspace was created but setup is '
            + 'incomplete. Re-run setup into a fresh target.',
        };
      }
      if (outcome.status === 'uncertain') {
        return {
          kind: 'incomplete',
          message:
            'Setup wrote the configuration document but could not confirm its durability. Setup is '
            + 'incomplete; inspect the file before re-running setup.',
        };
      }

      return { kind: 'committed', canonicalConfigPath: canonicalPath, ownerPaths };
    } finally {
      // Release ONLY what this caller acquired, owner before config, exactly once.
      if (ownerLease !== undefined) await ownerLease.release();
      await configLease.release();
    }
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
