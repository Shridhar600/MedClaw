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

/** What a fresh install commits. The identity is prospective because no document exists to read. */
export interface SetupInput {
  /**
   * Raw target for the configuration document. A fresh install has no document, so this is
   * canonicalized here rather than by a reader.
   */
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
  /**
   * Setup reached a real attempt and stopped part-way: a required record was not confirmed created,
   * or a published document's durability could not be confirmed. Distinct from `not-fresh`, which
   * means "there was existing owner evidence here and setup refuses to touch it".
   */
  | { kind: 'incomplete'; message: string };

/**
 * Refuse any pre-existing installation state. Returns the refusal text, or `undefined` when the
 * target is genuinely fresh. This replaces `--force`: there is no overwrite, no resume and no
 * unsolicited wipe, and a stale credential file or existing piece of owner evidence is left exactly
 * where it is.
 *
 * The caller must already hold BOTH leases when this runs (plan 15 §2.2), which is what makes the
 * answer trustworthy: nothing can appear or vanish between the check and the commit.
 *
 * `workspaceLease` is excluded, and so is the directory that holds it. Acquiring the owner lease
 * necessarily creates that metadata — plan §2.2 requires that "fresh structural parents/own lease
 * metadata do not make fresh setup falsely nonempty", and a check that counted them would refuse
 * every setup that ran while any contender held the lease. Anything else in the workspace, including
 * a sibling file inside the lease's own directory, is real owner content and still refuses.
 */
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

/**
 * True when the workspace holds something other than this caller's own lease metadata.
 *
 * The lease lives at `<workspace>/.state/installation.lease`, so freshness means: nothing in the
 * workspace except `.state`, and nothing in `.state` except `installation.lease`. A `ownerRecord`,
 * a session lane, or any stray file beside the lease is owner content and refuses.
 */
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

/**
 * Create only the private structural directories on the way to `target`, at 0700.
 *
 * Deliberately NOT `secureMkdir`: that helper calls `tightenDir` on the leaf, so handing it an
 * already-existing directory `chmod`s it. Scaffolding must never change the mode of a directory it
 * did not create — an existing ancestor is somebody else's, possibly a symlink whose target lives
 * outside this installation, and plan 15 §2.2/§7 give setup no authority over it.
 *
 * An already-existing component is left completely alone: not created, not `chmod`ed, not removed. An
 * `EEXIST` from `mkdir` only proves that an entry is present — not that this process made it, and not
 * that it is a usable directory — so it is accepted without further action and the lease's own
 * parent-state check decides whether it works.
 */
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
      // An entry is already there, so this component needs no creation, and its mode is not ours to
      // change. Whether it is a usable directory is decided by the lease's own parent-state check,
      // which refuses honestly if it is a file or a symlink to one.
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
    } catch {
      // `mkdir`'s mode is umask-affected and already owner-only in practice; a narrow directory is
      // still private to this owner, and mode hardening must never fail setup.
    }
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

/**
 * Build the unpaired owner record. `initialize()` is a no-op when one already exists and refuses
 * when the existing record is unreadable — setup must not overwrite or repair an existing record.
 *
 * `ownerStore` is the one injection seam: production builds the real file adapter, and a test that
 * has to prove what setup does when the RECORD WRITE fails or comes back unconfirmed supplies its own
 * port instead of mocking the surrounding lease machinery.
 */
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

  /**
   * Commit a NEW installation, holding both leases across the whole commit.
   *
   * The mirror image of {@link acquireOwnership}, and it exists as a separate method for a real
   * reason: that method READS the owner identity out of an existing document, so it cannot serve a
   * fresh install where no document exists yet. Setup therefore takes the prospective identity from
   * the caller and derives the owner paths from it, while keeping the identical lease order —
   * config first, validate inside it, then the owner workspace — and the identical rule that only the
   * leases this caller acquired are ever released.
   *
   * Why this is not optional bookkeeping: before it existed, setup ran a freshness CHECK and then
   * wrote the owner record and the configuration document holding no lease at all. A running daemon
   * holds both leases, so nothing stopped setup from committing a second installation beside it, and
   * two concurrent setups both passed the check. The CLI and the daemon then disagreed about which
   * document was authoritative. Plan 15 §2.2 requires "short-lived setup/config/pairing writers hold
   * both until their commit/refusal completes"; this is that requirement, implemented once, here.
   *
   * Wizard choices are gathered BEFORE this is called, so no prompt wait, provider probe or spawned
   * daemon happens inside a critical section.
   */
  async setup(input: SetupInput): Promise<SetupResult> {
    const { config: configToPersist, ownerId } = input;
    const { canonicalPath } = canonicalizeConfigPath(input.configPath);

    // The structural parents the CONFIG lease needs, created before acquisition. The lease is a
    // directory beside the document, so it cannot exist until its parent does, and real setup used
    // to refuse here with "its parent directory is missing" — which made the advertised first run
    // into `~/.redacted/config.json` impossible without the operator pre-creating a private folder.
    //
    // This creates STRUCTURE ONLY: empty private directories on the path to the document, nothing
    // else. No template, no owner record, no config bytes, and no authority of any kind — plan 15 §7
    // is explicit that creating the parents a lease needs grants nothing, and that a fresh target
    // must be re-checked under both leases before anything is published into it.
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

    // Everything below runs while the config lease is held, and every failure path releases it
    // before returning. The prospective owner paths come from the caller's identity, not a read.
    const ownerPaths = resolveOwnerPaths(configToPersist.profiles.baseDir, ownerId);
    let ownerLease: LeaseAcquired | undefined;
    try {
      const stored = toStoredView(configToPersist);

      // Validate the exact bytes we are about to persist through the same decoder startup uses, so
      // setup can never commit a document that refuses to serve.
      const decoded = decodeConfigDocument(stored, { homeDir: os.homedir() });
      if (decoded.kind === 'invalid') {
        return {
          kind: 'not-fresh',
          message: `Setup refused: the configuration is not valid and was not written. ${decoded.issues
            .map((issue) => `${issue.field}: ${issue.detail}`)
            .join('; ')}`,
        };
      }

      // Structural parents needed for the lease itself, created under the config lease. Creating
      // them grants no authority, and `assertFreshInstallation` is explicitly told to ignore this
      // caller's own lease metadata so a fresh target is not mistaken for an existing install.
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

      // Claim the lease IMMEDIATELY, before any further call that could throw. Assigning it after the
      // freshness check meant an `EACCES` from `readdirSync` on an unreadable-but-present workspace
      // (mode 0300, a restored backup, an ACL) escaped the `try` and left the owner lease ON DISK.
      // `finally` released only the config lease, so the target stayed permanently `busy`, reporting a
      // PID that had already exited — and plan 15 §2.2 forbids automatic recovery, so the target was
      // unusable until the operator removed it by hand. From here on, every path releases it.
      ownerLease = acquired;

      // Freshness is decided UNDER BOTH LEASES, which is what makes it trustworthy: nothing can
      // appear or vanish between this check and the commit below.
      const freshness = assertFreshInstallation(
        canonicalPath,
        ownerPaths.ownerRecord,
        ownerPaths.workspace,
        ownerPaths.workspaceLease,
      );
      if (freshness !== undefined) return { kind: 'not-fresh', message: freshness };

      // Under BOTH leases: scoped templates and state first, then the unpaired owner record, then
      // the configuration document LAST. That order means a document that exists always has a record
      // behind it, and a record never exists without one.
      ensureWorkspaceBootstrap(ownerPaths.workspace, { preserveExisting: true });
      secureMkdir(path.dirname(ownerPaths.schedulerStore));

      const attempt = await createUnpairedOwnerRecord(ownerPaths.ownerRecord, ownerId, this.options.ownerStore);
      const record = attempt.result;
      if (record !== 'created') {
        if (record === 'uncertain') {
          // `uncertain` means the outcome of the publication is UNKNOWN, not that it happened. A store
          // whose replacement throws before touching the disk — the lost-acknowledgement case — lands
          // here with nothing written at all, so this message must assert neither publication nor
          // nonpublication. A readback may establish that a record is present and readable; it can
          // never establish that the record was durably published, and an unreadable readback does not
          // establish absence either. Publishing no configuration and keeping whatever bytes are there
          // is unchanged: this is still not a fresh install and not an empty target.
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
          // Nothing was published, and nothing pre-existed either: this target was fresh and the
          // filesystem refused the write. It is incomplete, NOT not-fresh — telling the operator to
          // choose a different --state-root would be advice for a problem they do not have.
          return {
            kind: 'incomplete',
            message:
              `Setup could not create the owner record at ${ownerPaths.ownerRecord} (${record}). `
              + 'No configuration document was written, and the owner workspace that setup created is left in place. '
              + 'Setup never overwrites or repairs a workspace, so re-running it into this target is refused: '
              + 'check local permissions and disk space, then choose a fresh --state-root target.',
          };
        }
        // `exists` and `unavailable` are both refusals, and for the same reason: an existing or
        // unreadable record is owner evidence that setup must never overwrite or attempt to repair.
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
