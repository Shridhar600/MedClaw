
import * as fs from 'fs';
import * as path from 'path';
import { secureAppend, secureMkdir, summarizeErrorForLog } from '../security';

export interface CommittedLookup {
  found: boolean;
  result?: unknown;
}

export interface CaptureIdempotency {
  hasCommitted(key: string): boolean;
  /** `result` is stored alongside the commit marker so a replayed key can return the original
   *  result rather than `undefined`. Omit for callers with no result to cache. */
  markCommitted(key: string, result?: unknown): void;
  getCommittedResult(key: string): CommittedLookup;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const READ_CHUNK_BYTES = 64 * 1024;

function validKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** A durable set of completed capture event keys, each optionally carrying its cached result. */
export class FileCaptureIdempotency implements CaptureIdempotency {
  private readonly committed = new Map<string, unknown>();
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

  getCommittedResult(key: string): CommittedLookup {
    if (!validKey(key) || !this.committed.has(key)) return { found: false };
    return { found: true, result: this.committed.get(key) };
  }

  markCommitted(key: string, result?: unknown): void {
    if (!validKey(key)) throw new Error('invalid-capture-idempotency-key');
    if (this.committed.has(key)) return;
    if (!this.writable) throw new Error('capture-idempotency-unavailable');
    let record: string;
    try {
      record = JSON.stringify({ phase: 'commit', key, result });
    } catch (e) {
      console.warn(`[capture-idempotency] result not serializable; recording key only: ${summarizeErrorForLog(e)}`);
      record = JSON.stringify({ phase: 'commit', key });
    }
    secureAppend(this.filePath, `${record}\n`);
    this.committed.set(key, result);
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
      const parsed = JSON.parse(line) as { phase?: unknown; key?: unknown; result?: unknown };
      if (parsed.phase === 'commit' && typeof parsed.key === 'string' && validKey(parsed.key)) {
        this.committed.set(parsed.key, parsed.result);
      }
    } catch {
      // A torn marker line is ignored. The WriteQueue journal still exposes the uncertain source op.
    }
  }
}
