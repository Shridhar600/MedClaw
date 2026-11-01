
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

export interface OwnerRecordFileSync {
  syncFile(fd: number): void;
  syncDir(dirPath: string): void;
}

const realOwnerRecordSync: OwnerRecordFileSync = {
  syncFile(fd: number): void {
    fs.fsyncSync(fd);
  },
  syncDir(dirPath: string): void {
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

  async replace(next: OwnerState): Promise<OwnerStateWriteResult> {
    const content = encodeOwnerState(next);
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

function cleanupTmp(tmpPath: string, fd: number | undefined, owned: boolean): void {
  closeQuietly(fd);
  if (!owned) return;
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // Best effort: a leftover owner-scoped temp is never readable as a record.
  }
}
