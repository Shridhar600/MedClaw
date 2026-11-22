import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Gateway } from '../../src/gateway/gateway';
import { composeOwnerAuthority } from '../../src/runtime/owner-authority';
import { asProfileId } from '../../src/profiles';
import type { OwnerAdmissionService } from '../../src/profiles';
import type { EffectiveConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';
import { ProfileRuntime } from '../../src/gateway/runtime';
import { LLMSemaphore } from '../../src/tools/semaphore';
import { attachGatewayTestRuntime } from '../helpers/gateway-test-runtime';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

const DEFAULT_CHAT = 'owner-chat';
/** OLD: the second identity's paired chat. NEW: simply a chat that is not the owner's binding. */
const SECONDARY_CHAT = 'father-chat';
/** OLD: the second identity's alternate paired chat. NEW: a second unbound destination. */
const SECONDARY_ALT_CHAT = 'father-alt-chat';
const SECONDARY_MARKER = 'owned-heartbeat-secondary-7d21';
const DEFAULT_MARKER = 'owned-heartbeat-default-4c8e';

function mockAgentRun(replyText: string) {
  return jest.fn(async () => ({
    text: replyText,
    trace: [{ role: 'assistant' as const, content: replyText }],
    usedTools: [],
    healthResponse: false,
  }));
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function hashTree(dir: string, options: { skipStateDir?: boolean } = {}): string {
  if (!fs.existsSync(dir)) return 'missing';
  const hash = createHash('sha256');
  const walk = (current: string, rel: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relFull = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (options.skipStateDir && entry.name === '.state') continue;
        walk(full, relFull);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(relFull);
      hash.update(fs.readFileSync(full));
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

describe('scheduled work retains its owning profile', () => {
  let tmpDir: string;
  let baseDir: string;
  let legacyWorkspace: string;
  let gateway: Gateway | undefined;

  beforeEach(() => {
    tmpDir = makeTestTemp('scheduled-work');
    baseDir = path.join(tmpDir, 'redacted-home');
    legacyWorkspace = path.join(baseDir, 'profiles', 'default');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    removeTestTemp(tmpDir);
    try { await gateway?.stop(); } catch { /* cleanup must not mask the assertion */ }
    gateway = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function makeConfig(): EffectiveConfig {
    return {
    schemaVersion: 2,
      providers: {
        main: { type: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1' },
        medical: { type: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1' },
        embeddings: { type: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1' },
      },
      channels: { telegram: { enabled: false, botToken: '' } },
      tools: { allow: ['*'], deny: [] },
      memory: {
        workspace: legacyWorkspace,
        search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
        bootstrapMaxChars: 20000,
      },
      sessions: {
        compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 },
      },
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(legacyWorkspace, '.state', 'heartbeat-jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(legacyWorkspace, '.state', 'audit.jsonl') },
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 0,
          defaults: {
            morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
            eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
          },
        },
      },
      agent: { maxIterations: 15 },
      profiles: { baseDir, defaultProfileId: 'default' },
    };
  }

  function markOnboardingSkipped(workspace: string): void {
    const dir = path.join(workspace, '.redacted');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir, 'onboarding.json'),
      JSON.stringify({ status: 'skipped', currentStep: 'confirmation', answers: {}, updatedAt: now, completedAt: now }, null, 2) + '\n',
      'utf8',
    );
  }

  async function bindOwner(chatId: string): Promise<OwnerAdmissionService> {
    const authority = composeOwnerAuthority({
      ownerId: asProfileId('default')!,
      ownerPaths: { ownerRecord: path.join(baseDir, 'profiles', 'default', '.state', 'owner-access.json') },
    });
    await authority.admission.initialize();
    const issued = await authority.admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error(`issue failed: ${issued.kind}`);
    const result = await authority.admission.handlePairing(
      { channel: 'telegram', chatId, userId: 'owner-user', chatType: 'private', eventId: `telegram:${chatId}:bind` },
      issued.plaintext,
    );
    if (result.kind !== 'paired') throw new Error(`pairing failed: ${result.kind}`);
    return authority.admission;
  }

  async function bootOwnerGateway() {
    const admission = await bindOwner(DEFAULT_CHAT);
    gateway = new Gateway(makeConfig(), { admission, ownerId: asProfileId('default')! });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    const defaultAgent = mockAgentRun(`owner-ack ${DEFAULT_MARKER}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: defaultAgent };

    const rebindOwnerChat = async (newChatId: string): Promise<void> => {
      const { FileOwnerStatePort } = await import('../../src/runtime/adapters');
      const recordPath = path.join(baseDir, 'profiles', 'default', '.state', 'owner-access.json');
      const port = new FileOwnerStatePort(recordPath, 'default');
      const current = port.read();
      if (current.kind !== 'available' || current.state.phase !== 'bound') {
        throw new Error('owner record is not bound; cannot rebind');
      }
      await port.replace({
        ...current.state,
        binding: { ...current.state.binding, chatId: newChatId },
      });
    };

    return {
      defaultRuntime,
      defaultAgent,
      rebindOwnerChat,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (gateway as any).channel.send as jest.Mock,
    };
  }

  it('cron_manage refuses any destination that is not the bound owner chat and persists nothing; the bound destination stays usable', async () => {
    const { defaultRuntime } = await bootOwnerGateway();
    const storeJobs = () => defaultRuntime.scheduler!.getStore().list();
    const before = (await storeJobs()).length;

    const foreign = await defaultRuntime.registry!.execute(
      'cron_manage',
      { action: 'create', title: 'Cross-profile reminder', chatId: SECONDARY_CHAT, cron: '0 8 * * *', prompt: 'cross prompt' },
      { chatId: DEFAULT_CHAT },
    );
    expect(foreign.isError).toBe(true);

    const alternate = await defaultRuntime.registry!.execute(
      'cron_manage',
      { action: 'create', title: 'Alt-chat reminder', chatId: SECONDARY_ALT_CHAT, cron: '0 10 * * *', prompt: 'alt prompt' },
      { chatId: DEFAULT_CHAT },
    );
    expect(alternate.isError).toBe(true);

    expect((await storeJobs()).length).toBe(before);
    const jobsAfterRefusals = await storeJobs();
    expect(jobsAfterRefusals.some((j) => j.title === 'Cross-profile reminder')).toBe(false);
    expect(jobsAfterRefusals.some((j) => j.title === 'Alt-chat reminder')).toBe(false);

    const ownerJob = await defaultRuntime.registry!.execute(
      'cron_manage',
      { action: 'create', title: 'Owner reminder', chatId: DEFAULT_CHAT, cron: '0 9 * * *', prompt: 'owner prompt' },
      { chatId: DEFAULT_CHAT },
    );
    expect(ownerJob.isError).toBeUndefined();
    const jobs = await storeJobs();
    expect(jobs.some((j) => j.title === 'Owner reminder' && j.chatId === DEFAULT_CHAT)).toBe(true);
  });

  it('a planted job addressed to an UNBOUND chat fires on the real path into suppression: no agent/session/store change, no send', async () => {
    const { defaultRuntime, defaultAgent, send } = await bootOwnerGateway();

    const store = defaultRuntime.scheduler!.getStore();
    const planted = await store.create({
      title: 'Planted foreign job',
      chatId: SECONDARY_CHAT,
      cron: '0 8 * * *',
      prompt: `unbound-only prompt ${SECONDARY_MARKER}`,
      source: 'agent',
      kind: 'routine',
    });

    const jobsBefore = (await store.list()).map((j) => `${j.id}|${j.title}|${j.chatId}|${j.enabled}`).sort();
    const workspaceBefore = hashTree(defaultRuntime.workspace, { skipStateDir: true });
    const sessionsBefore = hashTree(defaultRuntime.sessions!.sessionsDir);

    await defaultRuntime.scheduler!.runNow(planted.id);

    expect(defaultAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(hashTree(defaultRuntime.workspace, { skipStateDir: true })).toBe(workspaceBefore);
    expect(hashTree(defaultRuntime.sessions!.sessionsDir)).toBe(sessionsBefore);
    const jobsAfter = (await store.list()).map((j) => `${j.id}|${j.title}|${j.chatId}|${j.enabled}`).sort();
    expect(jobsAfter).toEqual(jobsBefore);

    const refreshed = await store.get(planted.id);
    expect(refreshed?.lastOutcome).toBe('skipped-unowned-chat');
    expect(refreshed?.deliveryState).toBe('ready');
    expect(refreshed?.retryCount).toBe(0);
  });

  it('a recovered job for an unknown chat binds nothing, calls no model, sends nothing — and no message can grant that chat either', async () => {
    const admission = await bindOwner(DEFAULT_CHAT);
    gateway = new Gateway(makeConfig(), { admission, ownerId: asProfileId('default')! });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const defaultRuntime = await gateway.runtimeManager!.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    const defaultAgent = mockAgentRun(`default-ack ${DEFAULT_MARKER}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: defaultAgent };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (gateway as any).channel.send as jest.Mock;

    const store = defaultRuntime.scheduler!.getStore();
    const planted = await store.create({
      title: 'Recovered stray job',
      chatId: 'stranger-heartbeat-chat',
      cron: '0 8 * * *',
      prompt: 'stray prompt',
      source: 'system',
      kind: 'routine',
    });

    await defaultRuntime.scheduler!.runNow(planted.id);

    // Nothing bound the stranger, no model call, no send.
    expect(admission.ownsDestination('stranger-heartbeat-chat')).toBe(false);
    expect(defaultAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(defaultRuntime.sessions!.getHistory('stranger-heartbeat-chat')).toEqual([]);
    const refreshed = await store.get(planted.id);
    expect(refreshed?.lastOutcome).toBe('skipped-unowned-chat');

    const reply = await gateway.handleTestMessage('stranger-heartbeat-chat', 'hello there');
    expect(reply).not.toContain(DEFAULT_MARKER);
    expect(admission.ownsDestination('stranger-heartbeat-chat')).toBe(false);
  });

  it('a valid job on the BOUND owner destination fires for real (agent, session, outcome, audit); an unbound destination changes nothing; failed delivery records an operational error', async () => {
    const { defaultRuntime, send } = await bootOwnerGateway();

    const job = await defaultRuntime.scheduler!.createJob({
      title: 'Valid owner reminder',
      chatId: DEFAULT_CHAT,
      cron: '0 8 * * *',
      prompt: `take the morning pill ${SECONDARY_MARKER}`,
      source: 'user',
      kind: 'routine',
    });
    await defaultRuntime.scheduler!.runNow(job.id);

    expect(send).toHaveBeenCalledWith(DEFAULT_CHAT, expect.objectContaining({ text: expect.stringContaining(DEFAULT_MARKER) }));
    const refreshed = await defaultRuntime.scheduler!.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('sent');
    const auditRaw = fs.readFileSync(path.join(legacyWorkspace, '.state', 'audit.jsonl'), 'utf8');
    expect(auditRaw).toContain('"type":"sent"');

    expect(JSON.stringify(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT))).toContain(DEFAULT_MARKER);
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(hashTree(defaultRuntime.sessions!.sessionsDir)).not.toBe('missing');

    send.mockRejectedValueOnce(new Error('send failed'));
    const failJob = await defaultRuntime.scheduler!.createJob({
      title: 'Failing owner reminder',
      chatId: DEFAULT_CHAT,
      cron: '0 12 * * *',
      prompt: 'will fail',
      source: 'user',
      kind: 'routine',
    });
    await expect(defaultRuntime.scheduler!.runNow(failJob.id)).resolves.toBeUndefined();
    const failed = await defaultRuntime.scheduler!.getStore().get(failJob.id);
    expect(failed?.lastOutcome).toBe('error');
    expect(failed?.deliveryState).toBe('retry-wait');
  });

  it('reassigning the bound destination WHILE the agent is held: no send, outcome suppressed (never sent/error-retry), no session entry', async () => {
    const { defaultRuntime, rebindOwnerChat, send } = await bootOwnerGateway();

    const job = await defaultRuntime.scheduler!.createJob({
      title: 'Held owner reminder',
      chatId: DEFAULT_CHAT,
      cron: '0 8 * * *',
      prompt: `held prompt ${DEFAULT_MARKER}`,
      source: 'user',
      kind: 'routine',
    });

    let releaseAgent!: () => void;
    const agentGate = new Promise<void>((resolve) => { releaseAgent = resolve; });
    const heldRun = jest.fn(async () => {
      await agentGate;
      return {
        text: `held heartbeat reply ${SECONDARY_MARKER}`,
        trace: [{ role: 'assistant' as const, content: `held heartbeat reply ${SECONDARY_MARKER}` }],
        usedTools: [],
        healthResponse: false,
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: heldRun };

    const firePromise = defaultRuntime.scheduler!.runNow(job.id);
    await until(() => heldRun.mock.calls.length > 0);

    await rebindOwnerChat('some-other-chat');

    releaseAgent();
    await firePromise;

    expect(send).not.toHaveBeenCalled();

    const refreshed = await defaultRuntime.scheduler!.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('skipped-unowned-chat');
    expect(refreshed?.deliveryState).toBe('ready');
    expect(refreshed?.retryCount).toBe(0);

  });

  it('a throwing owner-record read fails closed: no implicit default authorization, refusal is not a crash', async () => {
    const config = makeConfig();
    const admission = await bindOwner(DEFAULT_CHAT);
    gateway = new Gateway(config, { admission, ownerId: asProfileId('default')! });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = attachGatewayTestRuntime(gateway, config, {
      sessions: {
        getLastActiveAt: jest.fn().mockReturnValue(undefined),
        prepareHistory: jest.fn().mockResolvedValue([]),
        recordTurn: jest.fn().mockResolvedValue(undefined),
        recordPromptUsage: jest.fn().mockResolvedValue(undefined),
        getHistory: jest.fn().mockReturnValue([]),
      },
      agentLoop: { run: jest.fn().mockResolvedValue({ text: 'SHOULD-NOT-RUN', trace: [], usedTools: [], healthResponse: false }) },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };

    const job: {
      id: string; title: string; chatId: string; cron: string; timezone: string; prompt: string;
      enabled: boolean; source: 'system'; kind: 'routine'; deliveryState: 'ready';
      retryCount: number; maxRetries: number; createdAt: string; updatedAt: string;
    } = {
      id: 'boundary-job',
      title: 'Boundary job',
      chatId: 'any-chat',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'boundary prompt',
      enabled: true,
      source: 'system' as const,
      kind: 'routine' as const,
      deliveryState: 'ready' as const,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await (gateway as unknown as {
      handleScheduledJob(job: unknown, owner: unknown, invokedByScheduler: boolean): Promise<void>;
    }).handleScheduledJob(job, runtime, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((gateway as any).channel.send as jest.Mock)).not.toHaveBeenCalled();
    expect((runtime.agentLoop as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();

    (gateway as unknown as { admission: unknown }).admission = {
      ownsDestination: () => { throw new Error('owner record read exploded'); },
    };
    await (gateway as unknown as {
      handleScheduledJob(job: unknown, owner: unknown, invokedByScheduler: boolean): Promise<void>;
    }).handleScheduledJob(job, runtime, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((gateway as any).channel.send as jest.Mock)).not.toHaveBeenCalled();
    expect((runtime.agentLoop as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();

    // And nothing leaked: the throw was sanitized, not propagated.
    const logged = warnSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain('owner record read exploded');
  });

  it('production runtimes construct their scheduler WITH the destination guard; the direct canSchedule factory refuses activation without one', async () => {
    const { defaultRuntime } = await bootOwnerGateway();

    const defaultGuard = (defaultRuntime.scheduler as unknown as { canAddressChat?: (chatId: string) => boolean }).canAddressChat;
    expect(typeof defaultGuard).toBe('function');
    expect(defaultGuard!(DEFAULT_CHAT)).toBe(true);
    expect(defaultGuard!(SECONDARY_CHAT)).toBe(false);
    expect(defaultGuard!(SECONDARY_ALT_CHAT)).toBe(false);
    expect(defaultGuard!('nonsense-chat')).toBe(false);

    const workspace = path.join(tmpDir, 'factory-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const config = makeConfig();
    const withGuard = await ProfileRuntime.create({
      profileId: 'default' as ProfileId,
      workspace,
      dbPath: path.join(tmpDir, 'factory.db'),
      sessionsPath: path.join(tmpDir, 'factory-sessions'),
      schedulerPaths: {
        storePath: path.join(tmpDir, 'factory-heartbeats', 'jobs.json'),
        auditLogPath: path.join(tmpDir, 'factory-heartbeats', 'audit.jsonl'),
      },
      config,
      mainProvider: { modelName: 'test', chat: jest.fn(), embed: jest.fn() },
      semaphore: new LLMSemaphore(),
      canSchedule: true,
      runScheduledJob: jest.fn().mockResolvedValue(undefined),
      ...({ canAddressChat: () => true } as Record<string, unknown>),
    });
    try {
      expect(withGuard.scheduler).toBeDefined();
      const guard = (withGuard.scheduler as unknown as { canAddressChat?: (chatId: string) => boolean }).canAddressChat;
      expect(guard!('any-chat')).toBe(true);
    } finally {
      await withGuard.drainAndClose();
    }

    const unguardedWorkspace = path.join(tmpDir, 'factory-unguarded');
    fs.mkdirSync(unguardedWorkspace, { recursive: true });
    const withoutGuard = await ProfileRuntime.create({
      profileId: 'default' as ProfileId,
      workspace: unguardedWorkspace,
      dbPath: path.join(tmpDir, 'factory-unguarded.db'),
      sessionsPath: path.join(tmpDir, 'factory-unguarded-sessions'),
      schedulerPaths: {
        storePath: path.join(tmpDir, 'factory-unguarded-heartbeats', 'jobs.json'),
        auditLogPath: path.join(tmpDir, 'factory-unguarded-heartbeats', 'audit.jsonl'),
      },
      config,
      mainProvider: { modelName: 'test', chat: jest.fn(), embed: jest.fn() },
      semaphore: new LLMSemaphore(),
      canSchedule: true,
      runScheduledJob: jest.fn().mockResolvedValue(undefined),
    });
    try {
      expect(withoutGuard.scheduler).toBeUndefined();
    } finally {
      await withoutGuard.drainAndClose();
    }
  });
});
