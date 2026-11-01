// src/runtime/adapters/owner-state-file.ts
//
// The one place the owner record touches the filesystem.
//
// Policy (what the record may contain) lives in `src/profiles/owner-state.ts`; this module only does
// bounded reads and one explicit flush-and-replace write, and validates raw storage through the
// profiles public decoder.
//
// Guarantees:
//  1. ONE byte budget on both sides. `OWNER_RECORD_MAX_BYTES` bounds the encoded write before
//     anything is published and the bytes read from the opened descriptor, so a record this writer
//     can produce is one the reader accepts. A `stat`-only precheck is not enough: the file can
//     grow between the check and the read.
//  2. Publication truth is decided here, at the rename boundary. A failure before the rename is
//     `failed` (previous bytes unchanged); a failure after it is `uncertain` (the new bytes are live
//     and readable) and is never swallowed or rolled back.
//  3. A record that cannot be read is reported unavailable, so the caller refuses rather than
//     renaming it aside and silently re-opening first-contact pairing.
//
// The filesystem sync step is injected so the uncertainty boundary can be driven in a real flow.

import * as fs from 'fs';
import * as path from 'path';
import { secureMkdir, tightenFile } from '../../security';
import { decodeOwnerState, encodeOwnerState } from '../../profiles';
import { OWNER_RECORD_MAX_BYTES } from '../../ports/owner-state';
import type { OwnerState, OwnerStateRead, OwnerStateWriteResult } from '../../ports/owner-state';

/** Re-exported so importers keep one name for the budget; the declaration lives in ports. */
export { OWNER_RECORD_MAX_BYTES };

/** Owner-only file mode, matching the rest of the owner's `.state` contents. */
const OWNER_RECORD_MODE = 0o600;

/**
 * The durability steps of one replacement, injectable so a test can drive a real publication
 * through a controlled post-rename failure. Same shape as `ConfigFileSync`.
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
   * Fresh read on every call, bounded on the OPENED descriptor rather than a prior `stat`. No
   * quarantine-to-empty: a record that cannot be understood is reported unavailable so the caller
   * refuses, instead of it being renamed aside and replaced by a re-openable installation.
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
   * directory fsync. Binding and challenge consumption are never observable half-applied.
   *
   * Order is the contract. Before the rename everything is `failed`: existing bytes are unchanged
   * and cleanup removes only this attempt's temp file. After it everything is `uncertain`: the new
   * bytes ARE the file's content and stay readable, so this never restores or deletes them.
   *
   * This is a process-crash guarantee on a POSIX filesystem that supports directory fsync, not a
   * claim about power loss.
   */
  async replace(next: OwnerState): Promise<OwnerStateWriteResult> {
    const content = encodeOwnerState(next);
    // Refuse BEFORE the filesystem is touched: the previous record is left as it was and no temp
    // file is created.
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
    // Ownership is tracked separately from the descriptor. A refused exclusive open means the file on
    // disk was NOT created by this attempt, and unlinking it would destroy unrelated bytes. It must
    // also survive `closeQuietly`: the rename-failure path closes the descriptor but still owns the temp.
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
    // Mode hardening must never fail a write, and the temp file already carried 0600 into the rename.
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
 * Remove ONLY the temp file this attempt actually created, never the record or a peer's temp.
 * `owned` is the guard, not `fd`: the rename-failure path has no descriptor but still owns its temp,
 * while a descriptor-less refusal means the colliding destination pre-existed and must stay.
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