// Concrete local resource lease: a non-recursive `mkdir` at 0700 with private holder metadata.
//
// The claim is the `mkdir` itself. There is no staging directory and no rename, because POSIX
// `rename(2)` replaces an existing EMPTY destination directory, which would let a leftover lease be
// taken as this process's own ownership. Non-recursive `mkdir` refuses with EEXIST for every
// existing entry (empty or populated directory, file, symlink, dangling symlink), and every one is
// refused as `busy`, never taken.
//
// The claim becomes visible one syscall before the holder record lands, so a contender inside that
// window cannot read the holder and reports `malformed-holder`. It refuses immediately: it never
// steals, waits, clears or repairs the claim. An unreadable holder is busy and never auto-recovered.
//
// Known limits:
//  - Only a local filesystem is covered. `mkdir` exclusivity is not portable to network filesystems,
//    and Windows semantics are not addressed.
//  - A kill or crash can leave a stale lease, or a claim whose holder record never landed. Clearing
//    either is a deliberate operator action after the recorded process is confirmed gone; there is
//    no TTL theft and no automatic unlock.
//  - Hostile same-UID descriptor races are out of scope.

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
        // A missing parent is fixable by creating it; a name taken by a file is not.
        guidance:
          parentState === 'not-a-directory'
            ? `The ${target.kind} resource cannot be owned because a path component in its location is not a directory. Choose a different --config or --state-root target.`
            : `The ${target.kind} resource cannot be owned because its parent directory is missing. Create the installation directory and retry.`,
      };
    }

    // The claim is one non-recursive `mkdir` at the lease path itself: it succeeds for exactly one
    // caller and refuses with EEXIST for every existing entry, so an unknown lease is never
    // replaced, cleared or repaired here.
    try {
      fs.mkdirSync(leasePath, { mode: DIR_MODE });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        // Something is already at the claim path. Leave it as it is and never treat it as free
        // (a dangling symlink included, which `existsSync` would call absent).
        return this.describeBusy(target, leasePath);
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') {
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

    // `mkdir`'s mode is umask-affected, so set the owner-only mode here, before the holder write.
    // A umask that strips owner bits would leave the claim at 0000: the holder write would fail and
    // the failed-attempt cleanup could not read the directory it must remove.
    try {
      fs.chmodSync(leasePath, DIR_MODE);
    } catch {
      // A narrow lease directory is still exclusive; ownership is not weakened by the mode.
    }

    const holder: LeaseHolder = { token: this.newToken(), pid: this.pid, kind: target.kind };
    try {
      const holderPath = path.join(leasePath, HOLDER_FILE);
      fs.writeFileSync(holderPath, `${JSON.stringify(holder)}\n`, {
        encoding: 'utf8',
        mode: FILE_MODE,
      });
      // `writeFileSync`'s mode is umask-affected too. Release reads this file to check the token, so
      // an unreadable record would make the caller's own lease impossible to release.
      try {
        fs.chmodSync(holderPath, FILE_MODE);
      } catch {
        // Mode hardening must not fail acquisition; exclusivity is already established.
      }
    } catch {
      // The claim exists but is not a usable lease. Remove exactly the artifact this attempt just
      // created, never another holder's, so the target stays retryable.
      removeClaimedLease(leasePath);
      return {
        kind: 'unavailable',
        resource: target.kind,
        reason: 'permission',
        guidance: `The ${target.kind} resource could not record its holder. Check local permissions and retry.`,
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
        // A malformed or replaced lease is never deleted by us; it stays visible for the operator.
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

/**
 * Discard a claim this attempt just created and then failed to publish.
 *
 * Only ever called after a successful exclusive `mkdir`, so the directory is this caller's own
 * artifact. It is removed only when nothing unexpected remains inside it; anything else is left for
 * the operator rather than deleted on a guess.
 */
function removeClaimedLease(leasePath: string): void {
  try {
    fs.rmSync(path.join(leasePath, HOLDER_FILE), { force: true });
  } catch {
    // Best effort: a leftover claim is visible and inspectable, never silently reused.
  }
  // Restore owner-only mode first so the removal below can list the directory even if the umask
  // created it narrower than intended.
  try {
    fs.chmodSync(leasePath, DIR_MODE);
  } catch {
    // Removal below is best effort regardless.
  }
  safeRemoveLeaseDir(leasePath);
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
  // `lstat`, not `existsSync`: acquisition treats a dangling symlink at the claim path as occupied,
  // so inspection must not report the installation as free.
  let claimExists: boolean;
  try {
    fs.lstatSync(leasePath);
    claimExists = true;
  } catch {
    claimExists = false;
  }
  if (!claimExists) return { present: false, readable: false };
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
