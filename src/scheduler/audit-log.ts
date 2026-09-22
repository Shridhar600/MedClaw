import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { rotateFileIfNeeded } from './rotation';
import { secureMkdir, secureAppend, summarizeErrorForLog } from '../security';
import type {
  SchedulerAuditEvent,
  SchedulerAuditEventInput,
  SchedulerAuditLogQuery,
} from './types';

const ROTATION_CHECK_INTERVAL = 100;
const TAIL_READ_CHUNK_BYTES = 64 * 1024;

export class SchedulerAuditLog {
  private appendCount = 0;

  constructor(
    private readonly filePath: string,
    private readonly profileId: string = 'default',
  ) {}

  async append(input: SchedulerAuditEventInput): Promise<SchedulerAuditEvent> {
    const event: SchedulerAuditEvent = {
      id: randomUUID(),
      jobId: input.jobId,
      chatId: input.chatId,
      type: input.type,
      at: input.at,
      details: input.details ?? {},
    };

    secureMkdir(path.dirname(this.filePath));

    this.appendCount++;
    // Check on the very first append (in case a prior process left the
    // file near/above the rotation threshold before this instance was
    // constructed), then every ROTATION_CHECK_INTERVAL appends after that.
    if (this.appendCount === 1 || this.appendCount % ROTATION_CHECK_INTERVAL === 0) {
      try {
        rotateFileIfNeeded(this.filePath);
      } catch (error) {
        // Rotation failures must never prevent the append itself. Sanitize the
        // error frame (defense-in-depth: review noted this path as unreachable
        // in practice, but the raw-object log was a PHI-leak surface).
        console.warn('[audit-log] rotation check failed, continuing without rotation:', summarizeErrorForLog(error));
      }
    }

    secureAppend(this.filePath, JSON.stringify(event) + '\n');
    return event;
  }

  /**
   * Reads recent audit events from the ACTIVE log file only. Rotated
   * `.N.gz` archives are not consulted — merging archived history into
   * this read path is a known limitation and future work.
   */
  async readRecent(query: SchedulerAuditLogQuery = {}): Promise<SchedulerAuditEvent[]> {
    if (query.limit === undefined) {
      const events = this.readAll();
      return query.jobId ? events.filter((event) => event.jobId === query.jobId) : events;
    }
    if (query.limit <= 0) {
      return [];
    }
    return this.readTail(query.limit, query.jobId);
  }

  /** Read only enough of the active JSONL tail to satisfy the requested recent-event window. */
  private readTail(limit: number, jobId?: string): SchedulerAuditEvent[] {
    if (!fs.existsSync(this.filePath)) return [];

    const fd = fs.openSync(this.filePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      let position = size;
      const parts: Buffer[] = [];
      let partBytes = 0;
      const newestFirst: SchedulerAuditEvent[] = [];
      const finishLine = (): void => {
        if (partBytes === 0) return;
        const raw = Buffer.concat(parts, partBytes).toString('utf8');
        parts.length = 0;
        partBytes = 0;
        if (raw.trim().length === 0) return;
        const event = this.parseLine(raw, 0);
        if (!jobId || event.jobId === jobId) newestFirst.push(event);
      };

      while (position > 0 && newestFirst.length < limit) {
        const length = Math.min(TAIL_READ_CHUNK_BYTES, position);
        position -= length;
        const chunk = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(fd, chunk, 0, length, position);
        let end = bytesRead;
        for (let i = bytesRead - 1; i >= 0 && newestFirst.length < limit; i--) {
          if (chunk[i] !== 0x0a) continue;
          if (i + 1 < end) {
            const part = chunk.subarray(i + 1, end);
            parts.unshift(part);
            partBytes += part.length;
          }
          finishLine();
          end = i;
        }
        if (newestFirst.length < limit && end > 0) {
          const part = chunk.subarray(0, end);
          parts.unshift(part);
          partBytes += part.length;
        }
      }
      if (newestFirst.length < limit) finishLine();
      newestFirst.reverse();
      return newestFirst;
    } finally {
      fs.closeSync(fd);
    }
  }

  private readAll(): SchedulerAuditEvent[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (raw.trim().length === 0) {
      return [];
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.map((line, index) => this.parseLine(line, index + 1));
  }

  private parseLine(line: string, lineNumber: number): SchedulerAuditEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid audit log entry at line ${lineNumber}: ${reason}`);
    }

    if (!this.isAuditEvent(parsed)) {
      throw new Error(`Invalid audit log entry at line ${lineNumber}: unexpected shape`);
    }

    return parsed;
  }

  private isAuditEvent(value: unknown): value is SchedulerAuditEvent {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const record = value as Record<string, unknown>;
    return (
      typeof record.id === 'string' &&
      typeof record.jobId === 'string' &&
      typeof record.chatId === 'string' &&
      typeof record.type === 'string' &&
      typeof record.at === 'string' &&
      typeof record.details === 'object' &&
      record.details !== null &&
      !Array.isArray(record.details)
    );
  }
}
