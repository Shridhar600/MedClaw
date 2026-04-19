import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeartbeatStore } from '../src/scheduler/store';
import { HeartbeatScheduler } from '../src/scheduler/runtime';
import { createHeartbeatManageTool } from '../src/tools/heartbeat-manage';

type Mode =
  | 'missed-run-recovery'
  | 'retry-success'
  | 'retry-dead-letter'
  | 'snooze-restart'
  | 'ack-restart';

function readAuditTypes(auditPath: string): string[] {
  if (!fs.existsSync(auditPath)) {
    return [];
  }
  return fs.readFileSync(auditPath, 'utf8')
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).type as string);
}

function assertSmoke(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Smoke assertion failed: ${message}`);
  }
}

async function runMissedRunRecovery(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3c-smoke-recovery-'));
  const storePath = path.join(baseDir, 'heartbeats', 'jobs.json');
  const auditPath = path.join(baseDir, 'heartbeats', 'audit.jsonl');
  const store = new HeartbeatStore(storePath);
  await store.create({
    title: 'Recovery demo',
    chatId: 'chat-1',
    cron: '0 8 * * *',
    timezone: 'UTC',
    prompt: 'Recover me.',
    source: 'system',
    kind: 'routine',
  });

  let triggerCount = 0;
  const scheduler = new HeartbeatScheduler(
    store,
    async () => {
      triggerCount += 1;
    },
    'UTC',
    {
      auditLogPath: auditPath,
      recoveryEnabled: true,
      recoveryWindowMinutes: 60,
      now: () => new Date('2026-04-19T08:30:00.000Z'),
    },
  );
  await scheduler.start();

  assertSmoke(triggerCount === 1, 'missed-run recovery should trigger exactly once');
  assertSmoke(readAuditTypes(auditPath).includes('recovered_missed_run'), 'audit should include recovered_missed_run');
  console.log(`RECOVERED_TRIGGER_COUNT=${triggerCount}`);
  console.log(`AUDIT_TYPES=${readAuditTypes(auditPath).join(',')}`);
  await scheduler.stop();
}

async function runRetrySuccess(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3c-smoke-retry-success-'));
  const storePath = path.join(baseDir, 'heartbeats', 'jobs.json');
  const auditPath = path.join(baseDir, 'heartbeats', 'audit.jsonl');
  let now = new Date('2026-04-19T08:00:00.000Z');
  let attempts = 0;
  const scheduler = new HeartbeatScheduler(
    new HeartbeatStore(storePath),
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('send failed');
      }
    },
    'UTC',
    {
      auditLogPath: auditPath,
      defaultMaxRetries: 1,
      retryBackoffMinutes: 0,
      now: () => now,
    },
  );
  await scheduler.start();
  const job = await scheduler.createJob({
    title: 'Retry success demo',
    chatId: 'chat-1',
    cron: '0 8 * * *',
    timezone: 'UTC',
    prompt: 'Retry me once.',
    source: 'system',
    kind: 'routine',
  });

  await scheduler.runNow(job.id);
  const first = await scheduler.getStore().get(job.id);
  now = new Date('2026-04-19T08:00:01.000Z');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await scheduler.getStore().get(job.id);

  assertSmoke(first?.deliveryState === 'retry-wait', 'first retry-success state should be retry-wait');
  assertSmoke(second?.deliveryState === 'ready', 'second retry-success state should be ready after automatic retry');
  assertSmoke(attempts === 2, 'retry-success should make exactly two attempts');
  console.log(`FIRST_STATE=${first?.deliveryState}`);
  console.log(`SECOND_STATE=${second?.deliveryState}`);
  console.log(`ATTEMPTS=${attempts}`);
  console.log(`AUDIT_TYPES=${readAuditTypes(auditPath).join(',')}`);
  await scheduler.stop();
}

async function runRetryDeadLetter(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3c-smoke-retry-dead-letter-'));
  const storePath = path.join(baseDir, 'heartbeats', 'jobs.json');
  const auditPath = path.join(baseDir, 'heartbeats', 'audit.jsonl');
  let now = new Date('2026-04-19T08:00:00.000Z');
  const scheduler = new HeartbeatScheduler(
    new HeartbeatStore(storePath),
    async () => {
      throw new Error('send failed');
    },
    'UTC',
    {
      auditLogPath: auditPath,
      defaultMaxRetries: 1,
      retryBackoffMinutes: 0,
      now: () => now,
    },
  );
  await scheduler.start();
  const job = await scheduler.createJob({
    title: 'Retry dead-letter demo',
    chatId: 'chat-1',
    cron: '0 8 * * *',
    timezone: 'UTC',
    prompt: 'Exhaust retries.',
    source: 'system',
    kind: 'routine',
  });

  await scheduler.runNow(job.id);
  now = new Date('2026-04-19T08:00:01.000Z');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const deadLettered = await scheduler.getStore().get(job.id);

  assertSmoke(deadLettered?.deliveryState === 'dead-letter', 'retry-dead-letter should end in dead-letter');
  assertSmoke(!!deadLettered?.deadLetterReason, 'dead-letter reason should be persisted');
  console.log(`FINAL_STATE=${deadLettered?.deliveryState}`);
  console.log(`DEAD_LETTER_REASON=${deadLettered?.deadLetterReason ?? '(none)'}`);
  console.log(`AUDIT_TYPES=${readAuditTypes(auditPath).join(',')}`);
  await scheduler.stop();
}

async function runSnoozeRestart(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3c-smoke-snooze-'));
  const workspacePath = path.join(baseDir, 'workspace');
  const storePath = path.join(baseDir, 'heartbeats', 'jobs.json');
  fs.mkdirSync(workspacePath, { recursive: true });
  let now = new Date('2026-04-19T08:00:00.000Z');
  let triggerCount = 0;

  let scheduler = new HeartbeatScheduler(
    new HeartbeatStore(storePath),
    async () => {
      triggerCount += 1;
    },
    'UTC',
    { now: () => now },
  );
  await scheduler.start();
  const tool = createHeartbeatManageTool(scheduler, workspacePath, () => now);
  const job = await scheduler.createJob({
    title: 'Snooze demo',
    chatId: 'chat-1',
    cron: '0 8 * * *',
    timezone: 'UTC',
    prompt: 'Snooze me.',
    source: 'system',
    kind: 'routine',
  });
  await tool.execute({ action: 'snooze', id: job.id, until: '2026-04-19T08:30:00.000Z' });
  await scheduler.stop();

  now = new Date('2026-04-19T08:10:00.000Z');
  scheduler = new HeartbeatScheduler(
    new HeartbeatStore(storePath),
    async () => {
      triggerCount += 1;
    },
    'UTC',
    { now: () => now },
  );
  await scheduler.start();
  await scheduler.runNow(job.id);
  const before = await scheduler.getStore().get(job.id);

  now = new Date('2026-04-19T08:31:00.000Z');
  await scheduler.runNow(job.id);
  const after = await scheduler.getStore().get(job.id);

  assertSmoke(triggerCount === 1, 'snooze restart should trigger once after expiry');
  assertSmoke(before?.deliveryState === 'snoozed', 'snooze restart before state should remain snoozed');
  assertSmoke(after?.deliveryState === 'ready', 'snooze restart after state should be ready');
  console.log(`TRIGGER_COUNT=${triggerCount}`);
  console.log(`BEFORE_STATE=${before?.deliveryState}`);
  console.log(`AFTER_STATE=${after?.deliveryState}`);
  await scheduler.stop();
}

async function runAckRestart(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3c-smoke-ack-'));
  const workspacePath = path.join(baseDir, 'workspace');
  const storePath = path.join(baseDir, 'heartbeats', 'jobs.json');
  fs.mkdirSync(workspacePath, { recursive: true });
  let now = new Date('2026-04-19T08:00:00.000Z');

  let scheduler = new HeartbeatScheduler(
    new HeartbeatStore(storePath),
    async () => undefined,
    'UTC',
    { now: () => now },
  );
  await scheduler.start();
  const tool = createHeartbeatManageTool(scheduler, workspacePath, () => now);
  const job = await scheduler.createJob({
    title: 'Ack demo',
    chatId: 'chat-1',
    cron: '0 8 * * *',
    timezone: 'UTC',
    prompt: 'Acknowledge me.',
    source: 'system',
    kind: 'routine',
  });
  await tool.execute({ action: 'ack', id: job.id });
  await scheduler.stop();

  scheduler = new HeartbeatScheduler(
    new HeartbeatStore(storePath),
    async () => undefined,
    'UTC',
    { now: () => now },
  );
  await scheduler.start();
  const persisted = await scheduler.getStore().get(job.id);

  assertSmoke(persisted?.acknowledgedAt === '2026-04-19T08:00:00.000Z', 'ack timestamp should persist');
  assertSmoke(persisted?.deliveryState === 'ready', 'ack should keep job ready');
  console.log(`ACKNOWLEDGED_AT=${persisted?.acknowledgedAt ?? '(none)'}`);
  console.log(`DELIVERY_STATE=${persisted?.deliveryState ?? '(missing)'}`);
  await scheduler.stop();
}

async function main(): Promise<void> {
  const mode = process.argv[2] as Mode | undefined;
  switch (mode) {
    case 'missed-run-recovery':
      await runMissedRunRecovery();
      break;
    case 'retry-success':
      await runRetrySuccess();
      break;
    case 'retry-dead-letter':
      await runRetryDeadLetter();
      break;
    case 'snooze-restart':
      await runSnoozeRestart();
      break;
    case 'ack-restart':
      await runAckRestart();
      break;
    default:
      throw new Error(`Unknown mode: ${mode ?? '(missing)'}`);
  }
}

void main();
