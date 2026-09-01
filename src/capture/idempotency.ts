// src/capture/idempotency.ts
//
// Durable capture commit markers. The marker file contains only opaque event keys and
// is therefore safe to use as the capture side of the WriteQueue begin/commit protocol.

import * as fs from 'fs';
import * as path from 'path';
import { secureAppend, secureMkdir, summarizeErrorForLog } from '../security';

export interface CaptureIdempotency {
  hasCommitted(key: string): boolean;
  markCommitted(key: string): void;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const READ_CHUNK_BYTES = 64 * 1024;

function validKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** A durable, PHI-free set of completed capture event keys. */
export class FileCaptureIdempotency implements CaptureIdempotency {
  private readonly committed = new Set<string>();
  private writable = true;

  constructor(private readonly filePath: string) {
    try {
      secureMkdir(path.dirname(filePath));
      this.load();
    } catch (e) {
      this.writable = false;
      console.warn(`[capture-idempotency] marker load failed; dedup degraded: ${summarizeErrorForLog(e)}`);
    }
  }

  hasCommitted(key: string): boolean {
    return validKey(key) && this.committed.has(key);
  }

  markCommitted(key: string): void {
    if (!validKey(key)) throw new Error('invalid-capture-idempotency-key');
    if (this.committed.has(key)) return;
    if (!this.writable) throw new Error('capture-idempotency-unavailable');
    secureAppend(this.filePath, `${JSON.stringify({ phase: 'commit', key })}\n`);
    this.committed.add(key);
  }

  private load(): void {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.filePath, 'r');
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let carry = '';
      let bytesRead: number;
      do {
        bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        carry += buffer.subarray(0, bytesRead).toString('utf8');
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) this.acceptLine(line);
      } while (bytesRead > 0);
      if (carry.length > 0) this.acceptLine(carry);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best-effort */ }
      }
    }
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as { phase?: unknown; key?: unknown };
      if (parsed.phase === 'commit' && typeof parsed.key === 'string' && validKey(parsed.key)) {
        this.committed.add(parsed.key);
      }
    } catch {
      // A torn marker line is ignored. The WriteQueue journal still exposes the uncertain source op.
    }
  }
}
