import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SchedulerAuditLog } from '../../src/scheduler/audit-log';

describe('SchedulerAuditLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-scheduler-audit-log-'));
    logPath = path.join(tmpDir, 'audit.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends one event', async () => {
    const log = new SchedulerAuditLog(logPath);
    const appended = await log.append({
      jobId: 'job-1',
      chatId: 'chat-1',
      type: 'triggered',
      at: '2026-04-19T08:00:00.000Z',
      details: { reason: 'cron' },
    });

    const events = await log.readRecent();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(appended);
    expect(events[0].id).toBeDefined();
    expect(events[0].jobId).toBe('job-1');
    expect(events[0].type).toBe('triggered');
  });

  it('appends multiple events in order', async () => {
    const log = new SchedulerAuditLog(logPath);
    await log.append({
      jobId: 'job-1',
      chatId: 'chat-1',
      type: 'triggered',
      at: '2026-04-19T08:00:00.000Z',
      details: { step: 1 },
    });
    await log.append({
      jobId: 'job-1',
      chatId: 'chat-1',
      type: 'sent',
      at: '2026-04-19T08:00:05.000Z',
      details: { step: 2 },
    });
    await log.append({
      jobId: 'job-1',
      chatId: 'chat-1',
      type: 'noop',
      at: '2026-04-19T08:00:10.000Z',
      details: { step: 3 },
    });

    const events = await log.readRecent();

    expect(events.map((event) => event.type)).toEqual(['triggered', 'sent', 'noop']);
    expect(events.map((event) => event.details)).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
  });

  it('filters recent events by job id', async () => {
    const log = new SchedulerAuditLog(logPath);
    await log.append({
      jobId: 'job-1',
      chatId: 'chat-1',
      type: 'triggered',
      at: '2026-04-19T08:00:00.000Z',
      details: { seq: 1 },
    });
    await log.append({
      jobId: 'job-2',
      chatId: 'chat-2',
      type: 'sent',
      at: '2026-04-19T08:01:00.000Z',
      details: { seq: 2 },
    });
    await log.append({
      jobId: 'job-1',
      chatId: 'chat-1',
      type: 'retry_scheduled',
      at: '2026-04-19T08:02:00.000Z',
      details: { seq: 3 },
    });
    await log.append({
      jobId: 'job-1',
      chatId: 'chat-1',
      type: 'sent',
      at: '2026-04-19T08:03:00.000Z',
      details: { seq: 4 },
    });

    const recent = await log.readRecent({ jobId: 'job-1', limit: 2 });

    expect(recent.map((event) => event.type)).toEqual(['retry_scheduled', 'sent']);
    expect(recent.every((event) => event.jobId === 'job-1')).toBe(true);
  });

  it('returns an empty list for an empty log', async () => {
    const log = new SchedulerAuditLog(logPath);

    await expect(log.readRecent()).resolves.toEqual([]);
  });
});
