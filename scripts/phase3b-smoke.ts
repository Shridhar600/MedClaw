import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../src/gateway/gateway';
import { SessionManager } from '../src/gateway/session';
import type { AppConfig } from '../src/config/types';
import type { HeartbeatJob } from '../src/scheduler/types';
import { HEARTBEAT_NOOP } from '../src/scheduler/delivery-policy';

type Mode =
  | 'startup-reconcile'
  | 'quiet-hours'
  | 'recent-activity'
  | 'noop'
  | 'workspace-update';

function makeConfig(baseDir: string, policyOverride?: Partial<AppConfig['heartbeat']['policy']>): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
      medical: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
      embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: path.join(baseDir, 'workspace'),
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: true,
      timezone: 'Asia/Kolkata',
      storePath: path.join(baseDir, 'heartbeats', 'jobs.json'),
      policy: {
        quietHours: { enabled: true, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 60,
        defaults: {
          morningCheckIn: { enabled: true, cron: '0 8 * * *', prompt: 'Morning check-in prompt.' },
          eveningSummary: { enabled: true, cron: '0 21 * * *', prompt: 'Evening summary prompt.' },
        },
        ...policyOverride,
      },
    },
    agent: { maxIterations: 15, disclaimerEnabled: true },
  };
}

async function setupGateway(config: AppConfig): Promise<{
  gateway: Gateway;
  sessions: SessionManager;
  sendCountRef: { count: number };
}> {
  fs.mkdirSync(config.memory.workspace, { recursive: true });
  const gateway = new Gateway(config);
  const sendCountRef = { count: 0 };
  const sessions = new SessionManager(
    config.sessions.softResetAfterMinutes,
    config.sessions.hardResetAfterMinutes,
    path.join(path.dirname(config.memory.workspace), 'sessions'),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).channel = {
    send: async () => {
      sendCountRef.count += 1;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).sessions = sessions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).agentLoop = {
    run: async () => ({
      text: 'Scheduled heartbeat delivered',
      trace: [{ role: 'assistant', content: 'Scheduled heartbeat delivered' }],
      usedTools: [],
      healthResponse: false,
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (gateway as any).initializeScheduler();
  return { gateway, sessions, sendCountRef };
}

function readHeartbeatMarkdown(workspacePath: string): string {
  return fs.readFileSync(path.join(workspacePath, 'HEARTBEAT.md'), 'utf8');
}

async function runStartupReconcile(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3b-smoke-startup-'));
  const config = makeConfig(baseDir);
  fs.mkdirSync(path.join(config.memory.workspace, 'medications'), { recursive: true });
  fs.writeFileSync(
    path.join(config.memory.workspace, 'medications', 'metformin.md'),
    '---\nstatus: active\ncron: "0 8,20 * * *"\nprompt: "Remind about Metformin."\n---\n# Metformin\n',
    'utf8',
  );

  fs.mkdirSync(path.join(baseDir, 'sessions'), { recursive: true });
  const gateway = new Gateway(config);
  const sessions = new SessionManager(
    config.sessions.softResetAfterMinutes,
    config.sessions.hardResetAfterMinutes,
    path.join(baseDir, 'sessions'),
  );
  await sessions.recordTurn('chat-smoke', [{ role: 'user', content: 'Seed startup reconcile chat.' }]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).channel = {
    send: async () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).sessions = sessions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).agentLoop = {
    run: async () => ({
      text: 'Scheduled heartbeat delivered',
      trace: [{ role: 'assistant', content: 'Scheduled heartbeat delivered' }],
      usedTools: [],
      healthResponse: false,
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (gateway as any).initializeScheduler();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs = await (gateway as any).scheduler.listJobs();
  const md = readHeartbeatMarkdown(config.memory.workspace);

  console.log(`JOBS_AFTER_STARTUP=${jobs.length}`);
  console.log(`HAS_DEFAULT_MORNING=${jobs.some((job: HeartbeatJob) => job.policyKey === 'defaults:morning-check-in')}`);
  console.log(`HAS_MEDICATION_JOB=${jobs.some((job: HeartbeatJob) => job.policyKey === 'medications:medications/metformin.md')}`);
  console.log(`HEARTBEAT_MD_HAS_MEDICATION=${md.includes('Metformin')}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (gateway as any).scheduler?.stop();
}

async function runQuietHours(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3b-smoke-quiet-'));
  const config = makeConfig(baseDir, {
    quietHours: { enabled: true, start: '22:00', end: '07:00' },
    defaults: {
      morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'unused' },
      eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'unused' },
    },
  });

  const { gateway, sendCountRef } = await setupGateway(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job = await (gateway as any).scheduler.createJob({
    title: 'Quiet-hours smoke',
    chatId: 'chat-smoke',
    cron: '0 23 * * *',
    prompt: 'Quiet hours should suppress this.',
    source: 'agent',
    kind: 'routine',
  });

  const originalNow = Date.now;
  Date.now = () => new Date('2026-04-18T22:30:00+05:30').getTime();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleScheduledJob(job);
  } finally {
    Date.now = originalNow;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refreshed = (await (gateway as any).scheduler.listJobs()).find((entry: HeartbeatJob) => entry.id === job.id);
  console.log(`SEND_COUNT=${sendCountRef.count}`);
  console.log(`LAST_OUTCOME=${refreshed?.lastOutcome ?? 'missing'}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (gateway as any).scheduler?.stop();
}

async function runRecentActivity(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3b-smoke-recent-'));
  const config = makeConfig(baseDir, {
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
    defaults: {
      morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'unused' },
      eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'unused' },
    },
  });

  const { gateway, sessions, sendCountRef } = await setupGateway(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job = await (gateway as any).scheduler.createJob({
    title: 'Recent-activity smoke',
    chatId: 'chat-smoke',
    cron: '0 20 * * *',
    prompt: 'Recent activity should suppress this.',
    source: 'agent',
    kind: 'routine',
  });

  const baseNow = new Date('2026-04-18T20:00:00+05:30').getTime();
  const sessionState = sessions.getOrCreateSessionState('chat-smoke');
  sessionState.lastActiveAt = new Date(baseNow - (30 * 60 * 1000));
  const originalNow = Date.now;
  Date.now = () => baseNow;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleScheduledJob(job);
  } finally {
    Date.now = originalNow;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refreshed = (await (gateway as any).scheduler.listJobs()).find((entry: HeartbeatJob) => entry.id === job.id);
  console.log(`SEND_COUNT=${sendCountRef.count}`);
  console.log(`LAST_OUTCOME=${refreshed?.lastOutcome ?? 'missing'}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (gateway as any).scheduler?.stop();
}

async function runNoop(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3b-smoke-noop-'));
  const config = makeConfig(baseDir, {
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
    defaults: {
      morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'unused' },
      eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'unused' },
    },
  });

  const { gateway, sendCountRef } = await setupGateway(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).agentLoop = {
    run: async () => ({
      text: HEARTBEAT_NOOP,
      trace: [{ role: 'assistant', content: HEARTBEAT_NOOP }],
      usedTools: [],
      healthResponse: false,
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job = await (gateway as any).scheduler.createJob({
    title: 'No-op smoke',
    chatId: 'chat-smoke',
    cron: '0 9 * * *',
    prompt: 'No-op expected.',
    source: 'agent',
    kind: 'routine',
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (gateway as any).handleScheduledJob(job);
  const sessionPath = path.join(path.dirname(config.memory.workspace), 'sessions', 'active-chat-smoke.jsonl');
  const sessionContent = fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, 'utf8') : '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refreshed = (await (gateway as any).scheduler.listJobs()).find((entry: HeartbeatJob) => entry.id === job.id);

  console.log(`SEND_COUNT=${sendCountRef.count}`);
  console.log(`SESSION_HAS_HEARTBEAT=${sessionContent.includes('[Heartbeat Trigger]')}`);
  console.log(`SESSION_HAS_NOOP=${sessionContent.includes(HEARTBEAT_NOOP)}`);
  console.log(`LAST_OUTCOME=${refreshed?.lastOutcome ?? 'missing'}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (gateway as any).scheduler?.stop();
}

async function runWorkspaceUpdate(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3b-smoke-workspace-'));
  const config = makeConfig(baseDir, {
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
  });
  const { gateway } = await setupGateway(config);

  fs.mkdirSync(path.join(config.memory.workspace, 'goals'), { recursive: true });
  fs.writeFileSync(
    path.join(config.memory.workspace, 'goals', 'walk.md'),
    '---\nstatus: active\ncron: "0 21 * * *"\nprompt: "Ask about walk v1."\n---\n# Daily walk\n',
    'utf8',
  );
  await gateway.handleTestMessage('chat-1', 'seed reconcile one');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const afterCreate = (await (gateway as any).scheduler.listJobs()).find(
    (job: HeartbeatJob) => job.policyKey === 'goals:goals/walk.md',
  );

  fs.writeFileSync(
    path.join(config.memory.workspace, 'goals', 'walk.md'),
    '---\nstatus: active\ncron: "0 21 * * *"\nprompt: "Ask about walk v2."\n---\n# Daily walk\n',
    'utf8',
  );
  await gateway.handleTestMessage('chat-1', 'seed reconcile two');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const afterUpdate = (await (gateway as any).scheduler.listJobs()).find(
    (job: HeartbeatJob) => job.policyKey === 'goals:goals/walk.md',
  );

  fs.unlinkSync(path.join(config.memory.workspace, 'goals', 'walk.md'));
  await gateway.handleTestMessage('chat-1', 'seed reconcile three');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const afterDelete = (await (gateway as any).scheduler.listJobs()).find(
    (job: HeartbeatJob) => job.policyKey === 'goals:goals/walk.md',
  );

  console.log(`CREATED_POLICY_JOB=${Boolean(afterCreate)}`);
  console.log(`UPDATED_POLICY_JOB=${afterUpdate?.prompt === 'Ask about walk v2.'}`);
  console.log(`STALE_POLICY_JOB_REMOVED=${!afterDelete}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (gateway as any).scheduler?.stop();
}

async function main(): Promise<void> {
  const mode = process.argv[2] as Mode | undefined;
  if (!mode) {
    throw new Error('Expected mode argument.');
  }

  if (mode === 'startup-reconcile') {
    await runStartupReconcile();
    return;
  }
  if (mode === 'quiet-hours') {
    await runQuietHours();
    return;
  }
  if (mode === 'recent-activity') {
    await runRecentActivity();
    return;
  }
  if (mode === 'noop') {
    await runNoop();
    return;
  }
  if (mode === 'workspace-update') {
    await runWorkspaceUpdate();
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
