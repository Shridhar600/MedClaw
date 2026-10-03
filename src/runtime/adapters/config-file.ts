// src/runtime/adapters/config-file.ts
//
// Bounded, honest filesystem access to the persisted configuration document.
//
// Three properties this adapter exists to guarantee:
//
//  1. The read cap is enforced on the OPENED read, not on a `stat` promise: a file that
//     grows between stat and read is still refused.
//  2. A config symlink resolves to its target before anything is written, and a
//     hard-linked config (`nlink > 1`) is refused outright. Claiming alias coherence
//     after a rename would be false.
//  3. A write reports `committed` / `uncertain` / `failed` honestly. `failed` means the
//     replacement never happened and the original bytes are intact. `uncertain` means the
//     rename DID land but a later durability step failed — the caller must not claim the
//     old bytes remain, must not blindly restore them, and must not claim crash
//     durability that the flush evidence does not support (plan 15 §8).
//
// The filesystem sync step is injected so the uncertainty boundary is provable in a real
// flow without a real power loss.

import * as fs from 'fs';
import * as path from 'path';
import { secureMkdir, tightenDir } from '../../security';

/** Maximum bytes accepted for a configuration document or owner record. */
export const MAX_CONFIG_BYTES = 256 * 1024;

export type ConfigFileReason =
  | 'missing'
  | 'too-large'
  | 'unreadable'
  | 'not-a-regular-file'
  | 'hard-linked'
  | 'unsafe-parent'
  | 'write-failed'
  | 'flush-failed'
  | 'chmod-failed';

export type ConfigReadResult =
  | { kind: 'ok'; text: string; bytes: number; canonicalPath: string }
  | { kind: 'missing'; canonicalPath: string }
  | { kind: 'unavailable'; reason: ConfigFileReason; canonicalPath: string };

export type ConfigWriteStatus = 'committed' | 'uncertain' | 'failed';

export interface ConfigWriteOutcome {
  status: ConfigWriteStatus;
  /**
   * True only when the replacement never reached the filesystem, so the previous bytes
   * are still the file's content. False for `committed` and for `uncertain`.
   */
  originalBytesPreserved: boolean;
  reason?: ConfigFileReason;
}

/** Filesystem durability steps. Injectable so the uncertainty boundary is testable. */
export interface ConfigFileSync {
  syncFile(fd: number): void;
  syncDir(dirPath: string): void;
}

const realSync: ConfigFileSync = {
  syncFile(fd: number): void {
    fs.fsyncSync(fd);
  },
  syncDir(dirPath: string): void {
    // Directory fsync is a POSIX durability request; a filesystem that rejects it is
    // reported honestly rather than treated as success.
    let fd: number | undefined;
    try {
      fd = fs.openSync(dirPath, 'r');
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore secondary close failure
        }
      }
    }
  },
};

export interface CanonicalPathResult {
  canonicalPath: string;
  /** Refused reasons that are about the target itself; `missing` is not a refusal. */
  refusal?: ConfigFileReason;
}

/**
 * Resolve the path that actually holds the bytes. An existing path is canonicalized with
 * `realpath`, so a symlinked config resolves to its target. A fresh path keeps its
 * validated shape; its nearest existing ancestor must still be inside a usable directory.
 */
export function canonicalizeConfigPath(targetPath: string): CanonicalPathResult {
  const absolute = path.resolve(targetPath);
  try {
    const real = fs.realpathSync(absolute);
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { canonicalPath: real, refusal: 'not-a-regular-file' };
    if (stat.nlink > 1) return { canonicalPath: real, refusal: 'hard-linked' };
    return { canonicalPath: real };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return { canonicalPath: absolute, refusal: 'unreadable' };
  }

  // Fresh path: the parent chain must already exist as real directories.
  const parent = path.dirname(absolute);
  try {
    const realParent = fs.realpathSync(parent);
    const parentStat = fs.statSync(realParent);
    if (!parentStat.isDirectory()) return { canonicalPath: absolute, refusal: 'unsafe-parent' };
    return { canonicalPath: path.join(realParent, path.basename(absolute)) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { canonicalPath: absolute, refusal: 'missing' };
    return { canonicalPath: absolute, refusal: 'unsafe-parent' };
  }
}

/**
 * Read the document with the cap enforced on the opened descriptor. A file that exceeds
 * the cap is refused as `too-large` rather than being loaded into memory first.
 */
export function readConfigFile(targetPath: string): ConfigReadResult {
  const { canonicalPath, refusal } = canonicalizeConfigPath(targetPath);
  if (refusal === 'missing') return { kind: 'missing', canonicalPath };
  if (refusal) return { kind: 'unavailable', reason: refusal, canonicalPath };

  let fd: number | undefined;
  try {
    fd = fs.openSync(canonicalPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: 'unavailable', reason: 'not-a-regular-file', canonicalPath };
    if (stat.nlink > 1) return { kind: 'unavailable', reason: 'hard-linked', canonicalPath };
    if (stat.size > MAX_CONFIG_BYTES) {
      return { kind: 'unavailable', reason: 'too-large', canonicalPath };
    }
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES);
    const read = fs.readSync(fd, buffer, 0, MAX_CONFIG_BYTES, 0);
    // Re-check the bytes actually read: a file that grew after fstat is still capped.
    if (read === MAX_CONFIG_BYTES) {
      const extra = Buffer.alloc(1);
      const more = fs.readSync(fd, extra, 0, 1, read);
      if (more > 0) return { kind: 'unavailable', reason: 'too-large', canonicalPath };
    }
    return { kind: 'ok', text: buffer.subarray(0, read).toString('utf8'), bytes: read, canonicalPath };
  } catch {
    return { kind: 'unavailable', reason: 'unreadable', canonicalPath };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore secondary close failure
      }
    }
  }
}

function ownerOnlyMode(existingPath: string): number {
  try {
    const existing = fs.statSync(existingPath).mode & 0o777;
    // Keep a narrower owner-only mode the operator chose; otherwise use 0o600. Never
    // preserve a group/other bit and never preserve 0o000.
    const noGroupOrOther = (existing & ~0o600) === 0;
    if (noGroupOrOther && existing !== 0) return existing;
  } catch {
    // fall through to the default
  }
  return 0o600;
}

/**
 * Replace the document atomically and report the real outcome.
 *
 * Order: parent directory, temp file at 0o600, file flush, rename, directory flush, final
 * mode. A failure before the rename leaves the original bytes intact (`failed`). A failure
 * after it is `uncertain`: the new bytes are in place but durability is unproven, so the
 * caller reports that instead of asserting the old content or restoring blindly.
 */
export function writeConfigFile(
  targetPath: string,
  contents: string,
  options: { sync?: ConfigFileSync } = {},
): ConfigWriteOutcome {
  const sync = options.sync ?? realSync;
  const { canonicalPath, refusal } = canonicalizeConfigPath(targetPath);
  if (refusal === 'hard-linked' || refusal === 'not-a-regular-file') {
    return { status: 'failed', originalBytesPreserved: true, reason: refusal };
  }

  const dir = path.dirname(canonicalPath);
  const tmpPath = path.join(dir, `.${path.basename(canonicalPath)}.tmp-${process.pid}-${Date.now()}`);
  const finalMode = ownerOnlyMode(canonicalPath);

  try {
    secureMkdir(dir);
  } catch {
    return { status: 'failed', originalBytesPreserved: true, reason: 'write-failed' };
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(fd, contents, { encoding: 'utf8' });
    try {
      sync.syncFile(fd);
    } catch {
      cleanupTmp(tmpPath, fd);
      return { status: 'failed', originalBytesPreserved: true, reason: 'flush-failed' };
    }
    try {
      fs.closeSync(fd);
    } catch {
      // the rename below still governs visibility
    }
    fd = undefined;
  } catch {
    cleanupTmp(tmpPath, fd);
    return { status: 'failed', originalBytesPreserved: true, reason: 'write-failed' };
  }

  try {
    fs.renameSync(tmpPath, canonicalPath);
  } catch {
    cleanupTmp(tmpPath, undefined);
    return { status: 'failed', originalBytesPreserved: true, reason: 'write-failed' };
  }

  // From here the replacement is visible. Nothing below may claim the old bytes survived.
  let uncertain: ConfigFileReason | undefined;
  try {
    sync.syncDir(dir);
  } catch {
    uncertain = 'flush-failed';
  }
  try {
    fs.chmodSync(canonicalPath, finalMode);
  } catch {
    uncertain = uncertain ?? 'chmod-failed';
  }
  tightenDir(dir);

  if (uncertain) return { status: 'uncertain', originalBytesPreserved: false, reason: uncertain };
  return { status: 'committed', originalBytesPreserved: false };
}

function cleanupTmp(tmpPath: string, fd: number | undefined): void {
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore secondary close failure
    }
  }
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {
    // Best effort: a leftover temp file never replaces the original document.
  }
}
