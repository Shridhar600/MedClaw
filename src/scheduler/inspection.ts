import * as fs from 'fs';
import type { HeartbeatJob } from './types';

export const MAX_HEARTBEAT_INSPECTION_BYTES = 256 * 1024;

/** Only the fields local inspection renders; this is not runtime recovery or job migration. */
export type InspectedHeartbeatJob = Pick<HeartbeatJob,
  'id' | 'title' | 'chatId' | 'cron' | 'timezone' | 'enabled' | 'deliveryState' | 'prompt'>;

export type HeartbeatInspection =
  | { kind: 'missing' }
  | { kind: 'ok'; jobs: InspectedHeartbeatJob[] }
  | { kind: 'corrupt' }
  | { kind: 'unavailable'; reason: 'too-large' | 'unreadable' | 'not-a-regular-file' };

function decodeInspectionJobs(input: unknown): InspectedHeartbeatJob[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const jobs: InspectedHeartbeatJob[] = [];
  for (const record of input) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
    const job = record as Record<string, unknown>;
    if (typeof job.id !== 'string' || typeof job.title !== 'string' || typeof job.chatId !== 'string'
      || typeof job.cron !== 'string' || typeof job.timezone !== 'string' || typeof job.prompt !== 'string'
      || typeof job.enabled !== 'boolean') return undefined;
    // The existing store's documented default; a supplied malformed value is never defaulted away.
    const deliveryState = job.deliveryState === undefined ? 'ready' : job.deliveryState;
    if (deliveryState !== 'ready' && deliveryState !== 'snoozed'
      && deliveryState !== 'retry-wait' && deliveryState !== 'dead-letter') return undefined;
    jobs.push({
      id: job.id, title: job.title, chatId: job.chatId, cron: job.cron, timezone: job.timezone,
      prompt: job.prompt, enabled: job.enabled, deliveryState,
    });
  }
  return jobs;
}

/** A bounded descriptor snapshot. No mkdir, chmod, quarantine, cache or runtime-store construction. */
export function inspectHeartbeats(filePath: string): HeartbeatInspection {
  let fd: number | undefined;
  try {
    // Nonblocking open prevents a non-file (e.g. FIFO) from hanging before the descriptor type check.
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: 'unavailable', reason: 'not-a-regular-file' };
    if (stat.size > MAX_HEARTBEAT_INSPECTION_BYTES) return { kind: 'unavailable', reason: 'too-large' };
    const buffer = Buffer.allocUnsafe(MAX_HEARTBEAT_INSPECTION_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    // At most one sentinel byte past the budget; growth/short reads cannot bypass this check.
    if (bytes > MAX_HEARTBEAT_INSPECTION_BYTES) return { kind: 'unavailable', reason: 'too-large' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    } catch {
      return { kind: 'corrupt' };
    }
    const jobs = decodeInspectionJobs(parsed);
    return jobs === undefined ? { kind: 'corrupt' } : { kind: 'ok', jobs };
  } catch (error) {
    if (fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unavailable', reason: 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* No secondary error or raw input disclosure. */ }
    }
  }
}
