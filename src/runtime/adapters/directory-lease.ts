// src/runtime/adapters/directory-lease.ts
//
// Concrete local resource lease: a non-recursive `mkdir` at 0700 with private holder metadata.
//
// The primitive was proved on this actual filesystem with real child processes before being
// integrated (see the S1 report, T2). Observed on `darwin arm64`, Node v26.7.0, local APFS
// (`statfs` type 26): 8 independent child processes released by an IPC barrier produced exactly
// one winner and seven `EEXIST` refusals; re-acquisition while held refused immediately with no
// retry; the next contender succeeded after release; a foreign token could not steal; release was
// idempotent; a malformed lease stayed busy and was never auto-cleared.
//
// Known limits, stated rather than papered over:
//  - Only a local filesystem is covered. `mkdir` exclusivity is not a portable guarantee on a
//    network filesystem, and Windows semantics are not addressed. No dependency or OS change is
//    made to manufacture one.
//  - A kill or crash can leave a stale lease. Clearing it is a deliberate operator action after
//    the recorded process is confirmed gone; there is no TTL theft and no automatic unlock.
//  - Hostile same-UID descriptor races are out of scope (existing backlog item).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  LeaseAcquired,
  LeaseBusy,
  LeaseHolder,
  LeaseResult,
  LeaseTarget,
  ResourceLeasePort,
} from '../../ports/resource-lease';

const HOLDER_FILE = 'holder.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Suffix appended to the canonical resource path to form its lease directory. */
export function leasePathFor(canonicalResourcePath: string): string {
  return `${canonicalResourcePath}.lease`;
}

/**
 * Whether a local process with this pid currently exists.
 *
 * Diagnostic only. A live, reused or unknown pid says nothing about whether a lease is stale, so
 * no automatic clearance is derived from it.
 */
export function isLocalProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface DirectoryLeaseOptions {
  /** Injected token source, so a test never has to predict a random UUID. */
  newToken?: () => string;
  /** Injected pid, so a test can assert recorded holder metadata. */
  pid?: number;
}

export class DirectoryLease implements ResourceLeasePort {
  private readonly newToken: () => string;
  private readonly pid: number;

  constructor(options: DirectoryLeaseOptions = {}) {
    this.newToken = options.newToken ?? (() => randomUUID());
    this.pid = options.pid ?? process.pid;
  }

  async tryAcquire(target: LeaseTarget): Promise<LeaseResult> {
    const leasePath = target.leasePath ?? leasePathFor(target.canonicalPath);

    const parentState = parentDirectoryState(leasePath);
    if (parentState !== 'directory') {
      return {
        kind: 'unavailable',
        resource: target.kind,
        reason: 'unsafe-parent',
        guidance: `The ${target.kind} resource cannot be owned because its parent directory is missing. Create the installation directory and retry.`,
      };
    }

    // The lease directory is BUILT under a private temporary name and then renamed into place.
    // A plain `mkdir` would expose the directory to other contenders before its holder record is
    // written, so a contender could observe a lease whose metadata does not exist yet. A same
    // filesystem directory rename is atomic and fails when the destination is a non-empty
    // directory, so exclusivity is unchanged and the lease is never seen half-built.
    const stagingPath = `${leasePath}.pending-${this.pid}-${process.hrtime.bigint().toString(36)}`;
    try {
      fs.mkdirSync(stagingPath, { mode: DIR_MODE });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          kind: 'unavailable',
          resource: target.kind,
          reason: 'unsafe-parent',
          guidance: `The ${target.kind} resource cannot be owned because its parent directory is missing. Create the installation directory and retry.`,
        };
      }
      return {
        kind: 'unavailable',
        resource: target.kind,
        reason: 'permission',
        guidance: `The ${target.kind} resource could not be owned: the filesystem refused the request. Check local permissions and retry.`,
      };
    }

    try {
      fs.chmodSync(stagingPath, DIR_MODE);
    } catch {
      // A narrow lease directory is still exclusive; ownership is not weakened by the mode.
    }

    const holder: LeaseHolder = { token: this.newToken(), pid: this.pid, kind: target.kind };
    try {
      fs.writeFileSync(path.join(stagingPath, HOLDER_FILE), `${JSON.stringify(holder)}\n`, {
        encoding: 'utf8',
        mode: FILE_MODE,
      });
    } catch {
      safeRemoveLeaseDir(stagingPath);
      return {
        kind: 'unavailable',
        resource: target.kind,
        reason: 'permission',
        guidance: `The ${target.kind} resource could not record its holder. Check local permissions and retry.`,
      };
    }

    try {
      fs.renameSync(stagingPath, leasePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Another contender won the race while this one was building its lease.
      safeRemoveLeaseDir(stagingPath);
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EACCES') {
        return this.describeBusy(target, leasePath);
      }
      return {
        kind: 'unavailable',
        resource: target.kind,
        reason: 'permission',
        guidance: `The ${target.kind} resource could not be owned: the filesystem refused the request. Check local permissions and retry.`,
      };
    }

    return this.acquiredResult(target, leasePath, holder);
  }

  private acquiredResult(target: LeaseTarget, leasePath: string, holder: LeaseHolder): LeaseAcquired {
    let released = false;
    return {
      kind: 'acquired',
      resource: target.kind,
      token: holder.token,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        if (releaseLeaseIfOwned(leasePath, holder.token)) {
          return;
        }
        // A malformed or replaced lease is never deleted by us; leaving it visible is the honest
        // outcome, and the operator still sees a lease to inspect.
      },
    };
  }

  private describeBusy(target: LeaseTarget, leasePath: string): LeaseBusy {
    const holder = readHolder(leasePath);
    if (holder === undefined) {
      return {
        kind: 'busy',
        resource: target.kind,
        reason: 'malformed-holder',
        holderState: 'malformed',
        guidance:
          'A lease for this resource exists but its holder record cannot be read, so ownership cannot be verified and it is never taken automatically. Stop any process that may still be using this installation, then remove that lease directory yourself.',
      };
    }
    return {
      kind: 'busy',
      resource: target.kind,
      reason: 'held',
      holderState: 'readable',
      recordedPidAlive: isLocalProcessAlive(holder.pid),
      guidance: `Another local process (recorded pid ${holder.pid}) holds this ${target.kind} resource. Wait for it to finish, or stop it and confirm the recorded process is gone before removing the lease yourself.`,
    };
  }
}

/** Read holder metadata, or `undefined` when it is absent or unparseable. */
export function readHolder(leasePath: string): LeaseHolder | undefined {
  try {
    const raw = fs.readFileSync(path.join(leasePath, HOLDER_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LeaseHolder>;
    if (typeof parsed?.token !== 'string' || parsed.token === '') return undefined;
    if (typeof parsed.pid !== 'number') return undefined;
    if (parsed.kind !== 'config' && parsed.kind !== 'owner') return undefined;
    return { token: parsed.token, pid: parsed.pid, kind: parsed.kind };
  } catch {
    return undefined;
  }
}

/**
 * Remove a lease only when the caller still owns it.
 *
 * Token-checked, so a foreign or replaced holder is never deleted. Idempotent: a second call with
 * the same token is a no-op. Returns whether this call removed the lease.
 */
export function releaseLeaseIfOwned(leasePath: string, token: string): boolean {
  const holder = readHolder(leasePath);
  if (holder === undefined) return false;
  if (holder.token !== token) return false;
  try {
    fs.rmSync(path.join(leasePath, HOLDER_FILE), { force: true });
  } catch {
    return false;
  }
  return safeRemoveLeaseDir(leasePath);
}

/** Remove the lease directory only when it is empty apart from its holder record. */
function safeRemoveLeaseDir(leasePath: string): boolean {
  try {
    const entries = fs.readdirSync(leasePath);
    if (entries.length > 0) return false;
    fs.rmdirSync(leasePath);
    return true;
  } catch {
    return false;
  }
}

/** `directory` | `missing` | `not-a-directory` for a lease's parent path. */
function parentDirectoryState(leasePath: string): 'directory' | 'missing' | 'not-a-directory' {
  const parent = path.dirname(leasePath);
  try {
    return fs.statSync(parent).isDirectory() ? 'directory' : 'not-a-directory';
  } catch {
    return 'missing';
  }
}

/**
 * Local operator inspection of a lease. Reports the resource kind and recorded pid without
 * logging the lease path, so it is safe to print.
 */
export function describeLeaseForLocalInspection(
  canonicalResourcePath: string,
): { present: boolean; resource?: LeaseHolder['kind']; pid?: number; pidAlive?: boolean; readable: boolean } {
  const leasePath = leasePathFor(canonicalResourcePath);
  if (!fs.existsSync(leasePath)) return { present: false, readable: false };
  const holder = readHolder(leasePath);
  if (holder === undefined) return { present: true, readable: false };
  return {
    present: true,
    readable: true,
    resource: holder.kind,
    pid: holder.pid,
    pidAlive: isLocalProcessAlive(holder.pid),
  };
}
