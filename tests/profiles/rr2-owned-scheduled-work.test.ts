import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { Gateway } from '../../src/gateway/gateway';
import { ProfileRegistry } from '../../src/profiles/registry';
import type { AppConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';
import { ProfileRuntime } from '../../src/gateway/runtime';
import { LLMSemaphore } from '../../src/tools/semaphore';
import { attachGatewayTestRuntime } from '../helpers/gateway-test-runtime';

// RR2-B1 (R2-10/R2-11): scheduled work retains its OWNING profile. Every production trigger
// closure captures its concrete ProfileRuntime; the job's `chatId` is a destination, never
// authority to select a runtime or claim pairing. Uses the rs5b real-Gateway two-profile boot
// pattern: real job stores/session files, scripted agent responses, no live networks.

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

const DEFAULT_CHAT = 'owner-chat';
const SECONDARY_CHAT = 'father-chat';
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

function hashTree(dir: string): string {
  if (!fs.existsSync(dir)) return 'missing';
  const hash = createHash('sha256');
  const walk = (current: string, rel: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relFull = path.join(rel, entry.name);
      if (entry.isDirectory()) { walk(full, relFull); continue; }
      if (!entry.isFile()) continue;
      hash.update(relFull);
      hash.update(fs.readFileSync(full));
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

describe('RR2-B1: scheduled work retains its owning profile (R2-10/R2-11)', () => {
  let tmpDir: string;
  let baseDir: string;
  let legacyWorkspace: string;
  let gateway: Gateway | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr2b1-'));
    baseDir = path.join(tmpDir, 'redacted-home');
    legacyWorkspace = path.join(tmpDir, 'legacy-workspace');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* cleanup must not mask the assertion */ }
    gateway = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function makeConfig(): AppConfig {
    return {
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
        softResetAfterMinutes: 240,
        hardResetAfterMinutes: 1440,
        compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
      },
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'legacy-heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'legacy-heartbeats', 'audit.jsonl') },
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 0,
          defaults: {
            morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
            eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
          },
        },
      },
      agent: { maxIterations: 15, disclaimerEnabled: true },
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

  async function bootTwoProfileGateway() {
    const registry = new ProfileRegistry(baseDir);
    const secondary = registry.createProfile('father');
    registry.pairChatToProfile(SECONDARY_CHAT, secondary.profileId);
    registry.pairChatToProfile(SECONDARY_ALT_CHAT, secondary.profileId);
    // Pair the default chat up-front too: the secondary pairing already closed first-contact
    // auto-pair, so an unpaired default chat would (correctly) be UNRECOGNIZED.
    const preRegistry = new ProfileRegistry(baseDir);
    preRegistry.getOrCreateDefaultProfile();
    preRegistry.pairChatToProfile(DEFAULT_CHAT, 'default' as ProfileId);
    gateway = new Gateway(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    const secondaryRuntime = await manager.get(secondary.profileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    markOnboardingSkipped(secondaryRuntime.workspace);
    const defaultAgent = mockAgentRun(`default-ack ${DEFAULT_MARKER}`);
    const secondaryAgent = mockAgentRun(`secondary-ack ${SECONDARY_MARKER}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: defaultAgent };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (secondaryRuntime as any).agentLoop = { run: secondaryAgent };
    return {
      secondaryId: secondary.profileId,
      defaultRuntime,
      secondaryRuntime,
      defaultAgent,
      secondaryAgent,
      liveRegistry: (gateway as unknown as { profileRegistry?: ProfileRegistry }).profileRegistry!,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (gateway as any).channel.send as jest.Mock,
    };
  }

  it('cron_manage through B runtime registry refuses a foreign (A-owned) destination and persists nothing in either store; same-profile alternates stay usable', async () => {
    const { defaultRuntime, secondaryRuntime } = await bootTwoProfileGateway();

    const secondaryStoreJobs = () => secondaryRuntime.scheduler!.getStore().list();
    const defaultStoreJobs = () => defaultRuntime.scheduler!.getStore().list();
    const secondaryBefore = (await secondaryStoreJobs()).length;
    const defaultBefore = (await defaultStoreJobs()).length;

    // B's model tries to point a reminder at A's chat.
    const foreign = await secondaryRuntime.registry!.execute(
      'cron_manage',
      { action: 'create', title: 'Cross-profile reminder', chatId: DEFAULT_CHAT, cron: '0 8 * * *', prompt: 'cross prompt' },
      { chatId: SECONDARY_CHAT },
    );
    expect(foreign.isError).toBe(true);

    // No job landed in either store.
    expect((await secondaryStoreJobs()).length).toBe(secondaryBefore);
    expect((await defaultStoreJobs()).length).toBe(defaultBefore);

    // Same-profile destinations remain usable: B's own chat AND a B-owned alternate chat.
    const own = await secondaryRuntime.registry!.execute(
      'cron_manage',
      { action: 'create', title: 'Own reminder', chatId: SECONDARY_CHAT, cron: '0 9 * * *', prompt: 'own prompt' },
      { chatId: SECONDARY_CHAT },
    );
    expect(own.isError).toBeUndefined();
    const alternate = await secondaryRuntime.registry!.execute(
      'cron_manage',
      { action: 'create', title: 'Alt-chat reminder', chatId: SECONDARY_ALT_CHAT, cron: '0 10 * * *', prompt: 'alt prompt' },
      { chatId: SECONDARY_CHAT },
    );
    expect(alternate.isError).toBeUndefined();
    const jobs = await secondaryStoreJobs();
    expect(jobs.some((j) => j.title === 'Own reminder' && j.chatId === SECONDARY_CHAT)).toBe(true);
    expect(jobs.some((j) => j.title === 'Alt-chat reminder' && j.chatId === SECONDARY_ALT_CHAT)).toBe(true);
    expect((await defaultStoreJobs()).length).toBe(defaultBefore);
  });

  it('a planted B-owned job addressed to A fires on the real path into suppression: no A agent/session/store change, no send to A', async () => {
    const { defaultRuntime, secondaryRuntime, secondaryId, defaultAgent, secondaryAgent, send } = await bootTwoProfileGateway();

    // Plant directly through the real HeartbeatStore fixture (bypasses the create guard
    // deliberately) so a stale/foreign record can be exercised on the real fire path.
    const store = secondaryRuntime.scheduler!.getStore();
    const planted = await store.create({
      title: 'Planted foreign job',
      chatId: DEFAULT_CHAT,
      cron: '0 8 * * *',
      prompt: `B-only prompt ${SECONDARY_MARKER}`,
      source: 'agent',
      kind: 'routine',
    });

    const aStoreBefore = JSON.stringify(await defaultRuntime.scheduler!.getStore().list());
    const aWorkspaceBefore = hashTree(defaultRuntime.workspace);
    const aSessionsBefore = hashTree(defaultRuntime.sessions!.sessionsDir);

    // Real production fire path: B's scheduler trigger → Gateway dispatch.
    await secondaryRuntime.scheduler!.runNow(planted.id);

    expect(defaultAgent).not.toHaveBeenCalled();
    expect(secondaryAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    // A's session and workspace untouched.
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(hashTree(defaultRuntime.workspace)).toBe(aWorkspaceBefore);
    expect(hashTree(defaultRuntime.sessions!.sessionsDir)).toBe(aSessionsBefore);
    expect(JSON.stringify(await defaultRuntime.scheduler!.getStore().list())).toBe(aStoreBefore);

    // Only B records a suppression outcome (honest refusal, not sent/error/retry).
    const refreshed = await store.get(planted.id);
    expect(refreshed?.lastOutcome).toBe('skipped-unowned-chat');
    expect(refreshed?.deliveryState).toBe('ready');
    expect(refreshed?.retryCount).toBe(0);
    expect(secondaryRuntime.profileId).toBe(secondaryId);
  });

  it('a recovered job for an unknown chat with an open pairing table pairs nothing, calls no model, sends nothing; genuine first contact still works', async () => {
    // Boot with NO pre-paired chats: first-contact auto-pair is still open.
    gateway = new Gateway(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    const defaultAgent = mockAgentRun(`default-ack ${DEFAULT_MARKER}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: defaultAgent };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (gateway as any).channel.send as jest.Mock;

    // Plant a recovered/persisted job addressed to a stranger through the real store.
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

    // No pairing was created for the stranger, no model call, no send.
    const onDisk = JSON.parse(fs.readFileSync(path.join(baseDir, 'profiles.json'), 'utf8')) as {
      profiles: Array<{ profileId: string; chatIds: string[] }>;
    };
    for (const profile of onDisk.profiles) {
      expect(profile.chatIds).not.toContain('stranger-heartbeat-chat');
    }
    expect(defaultAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(defaultRuntime.sessions!.getHistory('stranger-heartbeat-chat')).toEqual([]);
    const refreshed = await store.get(planted.id);
    expect(refreshed?.lastOutcome).toBe('skipped-unowned-chat');

    // Genuine first-contact behavior is unchanged (R2-10 scope boundary).
    const reply = await gateway.handleTestMessage('genuine-new-chat', 'hello there');
    expect(reply).toContain(DEFAULT_MARKER);
    const onDiskAfter = JSON.parse(fs.readFileSync(path.join(baseDir, 'profiles.json'), 'utf8')) as {
      profiles: Array<{ profileId: string; chatIds: string[] }>;
    };
    expect(onDiskAfter.profiles.find((p) => p.profileId === 'default')?.chatIds).toContain('genuine-new-chat');
  });

  it('a valid B job changes only B (agent, session, outcome, audit); A state stays byte-equivalent; failed delivery still records on B', async () => {
    const { defaultRuntime, secondaryRuntime, send } = await bootTwoProfileGateway();

    const aWorkspaceBefore = hashTree(defaultRuntime.workspace);
    const aSessionsBefore = hashTree(defaultRuntime.sessions!.sessionsDir);

    const job = await secondaryRuntime.scheduler!.createJob({
      title: 'Valid father reminder',
      chatId: SECONDARY_CHAT,
      cron: '0 8 * * *',
      prompt: `take the morning pill ${SECONDARY_MARKER}`,
      source: 'user',
      kind: 'routine',
    });
    await secondaryRuntime.scheduler!.runNow(job.id);

    expect(send).toHaveBeenCalledWith(SECONDARY_CHAT, expect.objectContaining({ text: expect.stringContaining(SECONDARY_MARKER) }));
    const refreshed = await secondaryRuntime.scheduler!.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('sent');
    const auditPath = new ProfileRegistry(baseDir).profileAuditLog(secondaryRuntime.profileId);
    const auditRaw = fs.readFileSync(auditPath, 'utf8');
    expect(auditRaw).toContain('"type":"sent"');

    // B's session holds the turn; A's stores/workspaces are byte-equivalent.
    expect(JSON.stringify(secondaryRuntime.sessions!.getHistory(SECONDARY_CHAT))).toContain(SECONDARY_MARKER);
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(hashTree(defaultRuntime.workspace)).toBe(aWorkspaceBefore);
    expect(hashTree(defaultRuntime.sessions!.sessionsDir)).toBe(aSessionsBefore);

    // Failed delivery still records on B (operational failure, not suppression).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((gateway as any).channel.send as jest.Mock).mockRejectedValueOnce(new Error('send failed'));
    const failJob = await secondaryRuntime.scheduler!.createJob({
      title: 'Failing father reminder',
      chatId: SECONDARY_CHAT,
      cron: '0 12 * * *',
      prompt: 'will fail',
      source: 'user',
      kind: 'routine',
    });
    await expect(secondaryRuntime.scheduler!.runNow(failJob.id)).resolves.toBeUndefined();
    const failed = await secondaryRuntime.scheduler!.getStore().get(failJob.id);
    expect(failed?.lastOutcome).toBe('error');
    expect(failed?.deliveryState).toBe('retry-wait');
  });

  it('reassigning the destination from B to A while the scripted B agent is held: no send to A, B outcome suppressed (never sent/error-retry), no A reconciliation', async () => {
    const { defaultRuntime, secondaryRuntime, liveRegistry, send } = await bootTwoProfileGateway();

    const job = await secondaryRuntime.scheduler!.createJob({
      title: 'Held father reminder',
      chatId: SECONDARY_CHAT,
      cron: '0 8 * * *',
      prompt: `held prompt ${SECONDARY_MARKER}`,
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
    (secondaryRuntime as any).agentLoop = { run: heldRun };

    const aWorkspaceBefore = hashTree(defaultRuntime.workspace);

    const firePromise = secondaryRuntime.scheduler!.runNow(job.id);
    await until(() => heldRun.mock.calls.length > 0);

    // The destination chat is reassigned to A's profile while the model is running.
    liveRegistry.pairChatToProfile(SECONDARY_CHAT, 'default' as ProfileId);

    releaseAgent();
    await firePromise;

    // No delivery to anyone (the chat now belongs to A; B may not send it).
    expect(send).not.toHaveBeenCalled();

    // B records an authorization suppression — not sent, not an operational error/retry.
    const refreshed = await secondaryRuntime.scheduler!.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('skipped-unowned-chat');
    expect(refreshed?.deliveryState).toBe('ready');
    expect(refreshed?.retryCount).toBe(0);

    // No reconciliation ran on A's runtime (ownership no longer holds for B).
    expect(hashTree(defaultRuntime.workspace)).toBe(aWorkspaceBefore);
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
  });

  it('scheduler boundary with no registry / throwing registry lookup: no implicit default authorization, refusal is not a crash', async () => {
    const config = makeConfig();
    const legacyConfig = { ...config } as AppConfig & { profiles?: unknown };
    delete legacyConfig.profiles; // legacy no-registry mode
    gateway = new Gateway(legacyConfig);
    const runtime = attachGatewayTestRuntime(gateway, legacyConfig, {
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

    // No registry on the gateway at all: nothing may authorize this chat by default.
    await (gateway as unknown as {
      handleScheduledJob(job: unknown, owner: unknown, invokedByScheduler: boolean): Promise<void>;
    }).handleScheduledJob(job, runtime, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((gateway as any).channel.send as jest.Mock)).not.toHaveBeenCalled();
    expect((runtime.agentLoop as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();

    // Registry lookup that THROWS: refusal is fail-closed and sanitized, never a crash.
    (gateway as unknown as { profileRegistry?: unknown }).profileRegistry = {
      getProfileForChat: () => { throw new Error('registry lookup exploded'); },
    };
    await (gateway as unknown as {
      handleScheduledJob(job: unknown, owner: unknown, invokedByScheduler: boolean): Promise<void>;
    }).handleScheduledJob(job, runtime, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((gateway as any).channel.send as jest.Mock)).not.toHaveBeenCalled();
    expect((runtime.agentLoop as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();
  });

  it('production runtimes construct their scheduler WITH the destination guard; the direct canSchedule factory refuses activation without one', async () => {
    const { defaultRuntime, secondaryRuntime } = await bootTwoProfileGateway();

    // Normal boot: every production scheduler carries the guard, wired to the real registry.
    const defaultGuard = (defaultRuntime.scheduler as unknown as { canAddressChat?: (chatId: string) => boolean }).canAddressChat;
    const secondaryGuard = (secondaryRuntime.scheduler as unknown as { canAddressChat?: (chatId: string) => boolean }).canAddressChat;
    expect(typeof defaultGuard).toBe('function');
    expect(typeof secondaryGuard).toBe('function');
    expect(defaultGuard!(DEFAULT_CHAT)).toBe(true);
    expect(defaultGuard!(SECONDARY_CHAT)).toBe(false);
    expect(secondaryGuard!(SECONDARY_CHAT)).toBe(true);
    expect(secondaryGuard!(DEFAULT_CHAT)).toBe(false);

    // Supported direct canSchedule:true factory path WITH a fixture predicate still activates.
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
      // Baseline-compatible: the guard dep does not exist pre-B1, so the extra key is
      // ignored there (behavioral RED) and type-checked after the interface gains it.
      ...({ canAddressChat: () => true } as Record<string, unknown>),
    });
    try {
      expect(withGuard.scheduler).toBeDefined();
      const guard = (withGuard.scheduler as unknown as { canAddressChat?: (chatId: string) => boolean }).canAddressChat;
      expect(guard!('any-chat')).toBe(true);
    } finally {
      await withGuard.drainAndClose();
    }

    // canSchedule:true WITHOUT a destination guard refuses scheduler activation
    // (never constructs an unguarded production scheduler) and does not crash boot.
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
