import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeartbeatStore } from '../../src/scheduler/store';
import { HeartbeatScheduler } from '../../src/scheduler/runtime';
import { createHeartbeatManageTool } from '../../src/tools/heartbeat-manage';

describe('heartbeat_manage tool', () => {
  let tmpDir: string;
  let workspacePath: string;
  let storePath: string;
  let auditPath: string;
  let currentNow: Date;
  let scheduler: HeartbeatScheduler;
  let trigger: jest.Mock;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-heartbeat-manage-'));
    workspacePath = path.join(tmpDir, 'workspace');
    storePath = path.join(tmpDir, 'heartbeats', 'jobs.json');
    auditPath = path.join(tmpDir, 'heartbeats', 'audit.jsonl');
    currentNow = new Date('2026-04-19T08:00:00.000Z');
    fs.mkdirSync(workspacePath, { recursive: true });
    trigger = jest.fn().mockResolvedValue(undefined);
    scheduler = new HeartbeatScheduler(
      new HeartbeatStore(storePath),
      trigger,
      'UTC',
      { now: () => currentNow, auditLogPath: auditPath },
    );
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists and inspects runtime job state', async () => {
    const tool = createHeartbeatManageTool(scheduler, workspacePath, () => currentNow);
    const created = await scheduler.createJob({
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'How are you feeling today?',
      source: 'system',
      kind: 'routine',
    });

    const listResult = await tool.execute({ action: 'list' });
    await scheduler.recordOutcome(created.id, 'sent');
    const inspectResult = await tool.execute({ action: 'inspect', id: created.id });

    expect(listResult.content[0].text).toContain('Morning check-in');
    expect(inspectResult.content[0].text).toContain('deliveryState: ready');
    expect(inspectResult.content[0].text).toContain(`id: ${created.id}`);
    expect(inspectResult.content[0].text).toContain('Recent audit events');
    expect(inspectResult.content[0].text).toContain('sent');
  });

  it('keeps snoozed jobs durable across restart', async () => {
    const tool = createHeartbeatManageTool(scheduler, workspacePath, () => currentNow);
    const created = await scheduler.createJob({
      title: 'Snoozed reminder',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'Snooze me.',
      source: 'system',
      kind: 'routine',
    });

    await tool.execute({
      action: 'snooze',
      id: created.id,
      until: '2026-04-19T08:30:00.000Z',
    });

    await scheduler.stop();
    currentNow = new Date('2026-04-19T08:10:00.000Z');
    scheduler = new HeartbeatScheduler(
      new HeartbeatStore(storePath),
      trigger,
      'UTC',
      { now: () => currentNow, auditLogPath: auditPath },
    );
    await scheduler.start();
    await scheduler.runNow(created.id);

    expect(trigger).not.toHaveBeenCalled();
    const persisted = await scheduler.getStore().get(created.id);
    expect(persisted?.deliveryState).toBe('snoozed');
    expect(persisted?.snoozedUntil).toBe('2026-04-19T08:30:00.000Z');
  });

  it('stores acknowledgements durably', async () => {
    const tool = createHeartbeatManageTool(scheduler, workspacePath, () => currentNow);
    const created = await scheduler.createJob({
      title: 'Ack reminder',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'Acknowledge me.',
      source: 'system',
      kind: 'routine',
    });

    await tool.execute({ action: 'ack', id: created.id });

    await scheduler.stop();
    scheduler = new HeartbeatScheduler(
      new HeartbeatStore(storePath),
      trigger,
      'UTC',
      { now: () => currentNow, auditLogPath: auditPath },
    );
    await scheduler.start();

    const persisted = await scheduler.getStore().get(created.id);
    expect(persisted?.acknowledgedAt).toBe('2026-04-19T08:00:00.000Z');
  });

  it('revives eligible dead-letter jobs via manual retry and lists dead letters', async () => {
    const tool = createHeartbeatManageTool(scheduler, workspacePath, () => currentNow);
    const created = await scheduler.createJob({
      title: 'Dead-letter reminder',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'Retry me.',
      source: 'system',
      kind: 'routine',
    });
    await scheduler.getStore().update(created.id, {
      deliveryState: 'dead-letter',
      deadLetterReason: 'retry budget exhausted',
      nextRetryAt: '2026-04-19T08:05:00.000Z',
    });

    const deadLetterList = await tool.execute({ action: 'dead_letter_list' });
    expect(deadLetterList.content[0].text).toContain('Dead-letter reminder');

    await tool.execute({ action: 'retry', id: created.id });

    const refreshed = await scheduler.getStore().get(created.id);
    expect(refreshed?.deliveryState).toBe('ready');
    expect(refreshed?.deadLetterReason).toBeUndefined();
    expect(refreshed?.nextRetryAt).toBeUndefined();
  });
});
