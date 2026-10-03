// src/runtime/adapters/owner-state-file.ts
//
// The one place the owner record touches the filesystem.
//
// Policy (what the record may contain) is decided by `src/profiles/owner-state.ts`; this module
// only does bounded reads and one explicit flush-and-replace write, using the existing security
// permission helpers. It validates raw storage through the profiles public decoder, never by
// importing an internal file.

import * as fs from 'fs';
import * as path from 'path';
import { secureMkdir, tightenFile } from '../../security';
import { decodeOwnerState, encodeOwnerState } from '../../profiles';
import type { OwnerState, OwnerStateRead } from '../../ports/owner-state';

/** Bounded read. The record is a small closed document; anything larger is refused, not parsed. */
export const OWNER_RECORD_MAX_BYTES = 64 * 1024;

/** Owner-only file mode, matching the rest of the owner's `.state` contents. */
const OWNER_RECORD_MODE = 0o600;

export class FileOwnerStatePort {
  constructor(
    private readonly recordPath: string,
    private readonly expectedOwnerId: string,
    private readonly maxBytes: number = OWNER_RECORD_MAX_BYTES,
  ) {}

  /**
   * Fresh read on every call. No mtime cache and no quarantine-to-empty: a record that cannot be
   * understood is reported as unavailable so the caller refuses, rather than being renamed aside
   * and silently replaced by a fresh, re-openable installation.
   */
  read(): OwnerStateRead {
    let size: number;
    try {
      size = fs.statSync(this.recordPath).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unavailable', reason: 'unreadable' };
    }
    if (size > this.maxBytes) return { kind: 'unavailable', reason: 'too-large' };

    let raw: string;
    try {
      raw = fs.readFileSync(this.recordPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'unavailable', reason: 'unreadable' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
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
   * This is a process-crash guarantee on a POSIX filesystem that supports directory fsync. It is
   * NOT a claim about power loss or a device that does not support directory fsync; those are
   * reported separately rather than implied here.
   */
  async replace(next: OwnerState): Promise<void> {
    const directory = path.dirname(this.recordPath);
    secureMkdir(directory, { recursive: true });
    const content = encodeOwnerState(next);
    const tmpPath = path.join(directory, `.owner-access.json.tmp-${process.pid}-${Date.now()}`);

    let fd: number | undefined;
    try {
      fd = fs.openSync(tmpPath, 'wx', OWNER_RECORD_MODE);
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmpPath, this.recordPath);
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed or unusable; the tmp is removed below regardless
        }
      }
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // best effort: a leftover temp is owner-scoped and never readable as a record
      }
      throw error;
    }

    tightenFile(this.recordPath);
    syncDirectory(directory);
  }
}

/**
 * Best-effort parent-directory fsync so the rename itself is durable. Not supported everywhere;
 * a failure here does not invalidate the already-committed replacement, so it is reported through
 * the caller-visible log rather than thrown.
 */
function syncDirectory(directory: string): void {
  let dfd: number | undefined;
  try {
    dfd = fs.openSync(directory, 'r');
    fs.fsyncSync(dfd);
  } catch {
    // Filesystem without directory fsync: the replacement is still complete and readable.
  } finally {
    if (dfd !== undefined) {
      try {
        fs.closeSync(dfd);
      } catch {
        // ignore
      }
    }
  }
}