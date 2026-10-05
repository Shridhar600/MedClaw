// src/runtime/adapters/owner-state-file.ts
//
// The one place the owner record touches the filesystem.
//
// Policy (what the record may contain) is decided by `src/profiles/owner-state.ts`; this module
// only does bounded reads and one explicit flush-and-replace write, using the existing security
// permission helpers. It validates raw storage through the profiles public decoder, never by
// importing an internal file.
//
// Three properties this adapter exists to guarantee:
//
//  1. ONE byte budget, enforced on both sides. The same `OWNER_RECORD_MAX_BYTES` bounds the encoded
//     write BEFORE anything is published and the bytes actually read from the opened descriptor
//     AFTER, so a record this writer could produce is a record the reader will accept. A `stat`-only
//     precheck is not enough: the file can grow between the check and the read.
//  2. Publication truth is decided HERE, because this is where the rename boundary is. A failure
//     before the rename is `failed` (previous bytes unchanged); a failure after it is `uncertain`
//     (the new bytes are live and readable) and is never swallowed and never rolled back.
//  3. A record that cannot be read is reported unavailable, so the caller refuses rather than
//     renaming it aside and silently re-opening first-contact pairing.
//
// The filesystem sync step is injected so the uncertainty boundary is provable in a real flow
// without a real power loss.

import * as fs from 'fs';
import * as path from 'path';
import { secureMkdir, tightenFile } from '../../security';
import { decodeOwnerState, encodeOwnerState } from '../../profiles';
import { OWNER_RECORD_MAX_BYTES } from '../../ports/owner-state';
import type { OwnerState, OwnerStateRead, OwnerStateWriteResult } from '../../ports/owner-state';

/** Re-exported so existing importers keep one name for the budget; the declaration lives in ports. */
export { OWNER_RECORD_MAX_BYTES };

/** Owner-only file mode, matching the rest of the owner's `.state` contents. */
const OWNER_RECORD_MODE = 0o600;

/**
 * The durability steps of one replacement, injectable so a real publication can be driven through a
 * controlled post-rename failure in tests. Same shape as `ConfigFileSync`, and for the same reason.
 */
export interface OwnerRecordFileSync {
  syncFile(fd: number): void;
  syncDir(dirPath: string): void;
}

const realOwnerRecordSync: OwnerRecordFileSync = {
  syncFile(fd: number): void {
    fs.fsyncSync(fd);
  },
  syncDir(dirPath: string): void {
    // Directory fsync is a POSIX durability request. A filesystem that rejects it is reported as
    // uncertainty, never treated as success and never treated as a failure of the rename.
    const dfd = fs.openSync(dirPath, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      try {
        fs.closeSync(dfd);
      } catch {
        // ignore secondary close failure
      }
    }
  },
};

export class FileOwnerStatePort {
  constructor(
    private readonly recordPath: string,
    private readonly expectedOwnerId: string,
    private readonly maxBytes: number = OWNER_RECORD_MAX_BYTES,
    private readonly sync: OwnerRecordFileSync = realOwnerRecordSync,
  ) {}

  /**
   * Fresh read on every call, bounded on the OPENED descriptor rather than on a prior `stat`. No mtime
   * cache and no quarantine-to-empty: a record that cannot be understood is reported as unavailable
   * so the caller refuses, rather than being renamed aside and silently replaced by a fresh,
   * re-openable installation.
   */
  read(): OwnerStateRead {
    let fd: number | undefined;
    let buffer: Buffer;
    let total: number;
    try {
      fd = fs.openSync(this.recordPath, 'r');
      if (fs.fstatSync(fd).size > this.maxBytes) return { kind: 'unavailable', reason: 'too-large' };
      // One byte beyond the budget, so growth after the fstat is caught by the read itself.
      buffer = Buffer.allocUnsafe(this.maxBytes + 1);
      total = 0;
      while (total < buffer.length) {
        const chunk = fs.readSync(fd, buffer, total, buffer.length - total, total);
        if (chunk === 0) break;
        total += chunk;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unavailable', reason: 'unreadable' };
    } finally {
      closeQuietly(fd);
    }

    if (total > this.maxBytes) return { kind: 'unavailable', reason: 'too-large' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, total).toString('utf8'));
    } catch {
      return { kind: 'unavailable', reason: 'invalid-document' };
    }

    const decoded = decodeOwnerState(parsed, this.expectedOwnerId);
    if (decoded.kind === 'ok') return { kind: 'available', state: decoded.state };
    if (decoded.kind === 'owner-mismatch') return { kind: 'unavailable', reason: 'owner-mismatch' };
    return { kind: 'unavailable', reason: 'invalid-document' };
  }

  /**
   * One atomic whole-record replacement: same-directory temp file, file fsync, rename, parent
   * directory fsync. Binding and challenge consumption are therefore never observable
   * half-applied.
   *
   * Order is the whole contract. Everything before the rename is `failed` — nothing was published,
   * existing bytes are unchanged and a missing record is still missing, and cleanup removes only this
   * attempt's temp file. Everything after it is `uncertain`: the new bytes ARE the file's content and
   * stay readable, so this never restores, deletes or denies them; it reports the incomplete
   * confirmation to the caller instead.
   *
   * This is a process-crash guarantee on a POSIX filesystem that supports directory fsync. It is NOT
   * a claim about power loss or a device that does not support directory fsync; those are reported
   * separately rather than implied here.
   */
  async replace(next: OwnerState): Promise<OwnerStateWriteResult> {
    const content = encodeOwnerState(next);
    // Refuse BEFORE the filesystem is touched at all. The previous readable record is left exactly
    // as it was, no temp file is created, and the caller reports a size refusal rather than a write
    // fault it cannot explain.
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) {
      return { status: 'failed', reason: 'too-large' };
    }

    const directory = path.dirname(this.recordPath);
    try {
      secureMkdir(directory, { recursive: true });
    } catch {
      return { status: 'failed', reason: 'write-failed' };
    }

    const tmpPath = path.join(directory, `.owner-access.json.tmp-${process.pid}-${Date.now()}`);

    let fd: number | undefined;
    // Ownership is tracked SEPARATELY from the descriptor, because the descriptor cannot answer this
    // question. A refused exclusive open means the file already on disk was NOT created by this
    // attempt — unlinking it would destroy pre-existing bytes that have nothing to do with this write.
    // Ownership must also survive `closeQuietly` below: the rename-failure path closes the descriptor
    // first and still owns the temp file it created.
    let ownsTmp = false;
    try {
      fd = fs.openSync(tmpPath, 'wx', OWNER_RECORD_MODE);
      ownsTmp = true;
      fs.writeFileSync(fd, content, 'utf8');
    } catch {
      cleanupTmp(tmpPath, fd, ownsTmp);
      return { status: 'failed', reason: 'write-failed' };
    }
    try {
      this.sync.syncFile(fd);
    } catch {
      cleanupTmp(tmpPath, fd, ownsTmp);
      return { status: 'failed', reason: 'flush-failed' };
    }
    closeQuietly(fd);
    fd = undefined;

    try {
      fs.renameSync(tmpPath, this.recordPath);
    } catch {
      // No descriptor any more, but the temp is still this attempt's to remove.
      cleanupTmp(tmpPath, undefined, true);
      return { status: 'failed', reason: 'write-failed' };
    }

    // Past the rename the new record is live. Nothing below may claim the old bytes survived.
    // `tightenFile` keeps its existing graceful warn-and-continue behaviour (plan 15 §7 mode
    // hardening must never fail a write), and the temp file already carried 0600 into the rename.
    tightenFile(this.recordPath);
    try {
      this.sync.syncDir(directory);
    } catch {
      return { status: 'uncertain', reason: 'flush-failed' };
    }
    return { status: 'committed' };
  }
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // ignore secondary close failure
  }
}

/**
 * Remove ONLY the temp file this attempt actually created. Never the record, never a peer's temp.
 *
 * `owned` is the guard, deliberately not `fd`. No descriptor does not mean no ownership — the
 * rename-failure path closes the descriptor and still owns its temp — and a descriptor-less refusal
 * means the opposite, that the colliding destination pre-existed and must be left exactly as it is.
 */
function cleanupTmp(tmpPath: string, fd: number | undefined, owned: boolean): void {
  closeQuietly(fd);
  if (!owned) return;
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // Best effort: a leftover owner-scoped temp is never readable as a record.
  }
}