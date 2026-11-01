
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

    try {
      fs.mkdirSync(leasePath, { mode: DIR_MODE });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
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
      try {
        fs.chmodSync(holderPath, FILE_MODE);
      } catch {
        // Mode hardening must not fail acquisition; exclusivity is already established.
      }
    } catch {
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

function removeClaimedLease(leasePath: string): void {
  try {
    fs.rmSync(path.join(leasePath, HOLDER_FILE), { force: true });
  } catch {
    // Best effort: a leftover claim is visible and inspectable, never silently reused.
  }
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

export function describeLeaseForLocalInspection(
  canonicalResourcePath: string,
): { present: boolean; resource?: LeaseHolder['kind']; pid?: number; pidAlive?: boolean; readable: boolean } {
  const leasePath = leasePathFor(canonicalResourcePath);
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
