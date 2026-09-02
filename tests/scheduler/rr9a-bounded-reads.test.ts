import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SchedulerAuditLog } from '../../src/scheduler/audit-log';
import { HeartbeatStore } from '../../src/scheduler/store';

const tmpDirs: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('RR-9a R6-17 bounded scheduler reads', () => {
  it('readRecent(limit) parses only the tail needed for the last events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-audit-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'audit.jsonl');
    const lines = Array.from({ length: 250 }, (_, index) => JSON.stringify({
      id: `event-${index}`,
      jobId: 'job-1',
      chatId: 'chat-1',
      type: 'noop',
      at: `2026-08-29T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      details: { index },
    }));
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
    const log = new SchedulerAuditLog(filePath);
    const parse = jest.spyOn(JSON, 'parse');

    const events = await log.readRecent({ limit: 5 });

    expect(events.map((event) => event.details.index)).toEqual([245, 246, 247, 248, 249]);
    expect(parse).toHaveBeenCalledTimes(5);
  });

  it('reuses a valid scheduler-state snapshot across reads in one store instance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-store-'));
    tmpDirs.push(dir);
    const storePath = path.join(dir, 'jobs.json');
    const store = new HeartbeatStore(storePath);
    await store.create({
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'Ask how the user is feeling.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
    });
    const parse = jest.spyOn(JSON, 'parse');

    await store.get('missing');
    await store.list();
    await store.findByPolicyKey('defaults:morning-check-in');

    // The write path seeds the same snapshot, so repeated reads need no JSON parse at all.
    expect(parse).toHaveBeenCalledTimes(0);
  });

  it('loads a large JSON-array scheduler state without readFileSync slurping it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-stream-'));
    tmpDirs.push(dir);
    const storePath = path.join(dir, 'jobs.json');
    const jobs = Array.from({ length: 1200 }, (_, index) => ({
      id: `job-${index}`,
      title: `Reminder ${index}`,
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'Asia/Kolkata',
      prompt: `Prompt ${index}`,
      enabled: true,
      source: 'system',
      kind: 'routine',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    }));
    fs.writeFileSync(storePath, JSON.stringify(jobs, null, 2));
    const store = new HeartbeatStore(storePath);
    const fsReal = jest.requireActual<typeof import('fs')>('fs');
    const readFile = jest.spyOn(fsReal, 'readFileSync');

    const loaded = await store.list();

    expect(loaded).toHaveLength(1200);
    expect(loaded[1199].id).toBe('job-1199');
    expect(readFile.mock.calls.filter(([file]) => String(file).endsWith('jobs.json'))).toHaveLength(0);
  });

  it('reads a large Unicode audit record across a buffer boundary without a trailing newline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-audit-boundary-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'audit.jsonl');
    const event = (id: string, index: number) => JSON.stringify({
      id,
      jobId: 'job-1',
      chatId: 'chat-1',
      type: 'noop',
      at: '2026-08-29T00:00:00.000Z',
      details: { payload: `${'健康'.repeat(40_000)}-${index}` },
    });
    fs.writeFileSync(filePath, `${event('first', 1)}\n${event('last', 2)}`);

    const recent = await new SchedulerAuditLog(filePath).readRecent({ limit: 1 });

    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe('last');
    expect(recent[0].details.payload).toBe(`${'健康'.repeat(40_000)}-2`);
  });
});
