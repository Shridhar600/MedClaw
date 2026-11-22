import * as fs from 'fs';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { GatewayMessageRouter } from '../../src/gateway/router';
import type { EffectiveConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';
import { EMERGENCY_RESPONSE } from '../../src/safety/emergency-detector';
import {} from '../helpers/test-config';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';
import { makeTestTemp } from '../helpers/test-temp';

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

const SECONDARY_CHAT = 'father-chat';
const DEFAULT_CHAT = 'owner-chat';
const SECONDARY_MARKER = 'secondary-profile-turn-alpha-9f3c';
const DEFAULT_MARKER = 'default-profile-turn-alpha-51bd';

function mockAgentRun(replyText: string, onRun?: (input: string) => Promise<void> | void) {
  return jest.fn(async (input: string) => {
    if (onRun) await onRun(input);
    return {
      text: replyText,
      trace: [{ role: 'assistant' as const, content: replyText }],
      usedTools: [],
      healthResponse: false,
    };
  });
}

describe('live multi-profile dispatch', () => {
  let tmpDir: string;
  let baseDir: string;
  let legacyWorkspace: string;
  let gateway: Gateway | undefined;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-');
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
      agent: { maxIterations: 15 },
      profiles: { baseDir, defaultProfileId: 'default' },
    };
  }

  async function boundGateway(root: string): Promise<Gateway> {
    const bound = await bindOwnerFixture(
      path.join(root, 'profiles', 'default', '.state', 'owner-access.json'),
      'default',
      DEFAULT_CHAT,
      { channel: 'local', userId: 'local' },
    );
    return new Gateway(makeConfig(), bound.gatewayDeps);
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

  function grepTree(dir: string, needle: string): string[] {
    const hits: string[] = [];
    if (!fs.existsSync(dir)) return hits;
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        try {
          if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(path.relative(dir, full));
        } catch { /* unreadable file — not a match */ }
      }
    };
    walk(dir);
    return hits;
  }

  // The agent double writes one ledger fact per turn, so an end-to-end memory-write proof survives.
  async function bootOwnerGateway() {
    gateway = await boundGateway(baseDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const defaultRuntime = await gateway.runtimeManager!.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    const defaultAgent = mockAgentRun(`default-ack ${DEFAULT_MARKER}`, async () => {
      await defaultRuntime.ledgerStore!.recordFact({
        entity: 'default-only-med', type: 'medication',
        fields: { dose: '5mg' },
        provenance: { source: 'user', confidence: 1, anchor: 'memory/x.md#L1', capturedAt: new Date().toISOString() },
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: defaultAgent };
    return { defaultRuntime, defaultAgent };
  }

  it('a message from an UNBOUND chat is REFUSED and reaches no runtime at all', async () => {
    const { defaultRuntime, defaultAgent } = await bootOwnerGateway();

    const reply = await gateway!.handleTestMessage(SECONDARY_CHAT, `my bp reading ${SECONDARY_MARKER}`);

    expect(reply).toMatch(/not connected to this assistant/i);
    // And no model was invoked for it.
    expect(defaultAgent).not.toHaveBeenCalled();

    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, SECONDARY_MARKER)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'secondary-only-med')).toEqual([]);
    const meds = await defaultRuntime.ledgerStore!.listAllOfType('medication');
    expect(meds.some((f) => f.entity === 'secondary-only-med')).toBe(false);
    expect(meds).toEqual([]);
  });

  it('interleaved traffic: the owner is served, the unbound chat is refused, zero cross-contamination', async () => {
    const { defaultRuntime, defaultAgent } = await bootOwnerGateway();

    const r1 = await gateway!.handleTestMessage(DEFAULT_CHAT, `default note ${DEFAULT_MARKER}`);
    const r2 = await gateway!.handleTestMessage(SECONDARY_CHAT, `secondary note ${SECONDARY_MARKER}`);
    const r3 = await gateway!.handleTestMessage(DEFAULT_CHAT, 'default follow-up');
    expect(r1).toContain(DEFAULT_MARKER);
    expect(r2).toMatch(/not connected to this assistant/i);
    expect(r3).toContain(DEFAULT_MARKER);
    expect(defaultAgent).toHaveBeenCalledTimes(2);

    const defaultHistory = JSON.stringify(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT));
    expect(defaultHistory).toContain(DEFAULT_MARKER);
    expect(defaultHistory).not.toContain(SECONDARY_MARKER);
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);

    expect(grepTree(defaultRuntime.workspace, SECONDARY_MARKER)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'secondary-only-med')).toEqual([]);
    const meds = await defaultRuntime.ledgerStore!.listAllOfType('medication');
    expect(meds.some((f) => f.entity === 'secondary-only-med')).toBe(false);
    expect(meds.some((f) => f.entity === 'default-only-med')).toBe(true);
  });

  it('gives an UNBOUND chat canned emergency guidance and persists nothing', async () => {
    const { defaultRuntime, defaultAgent } = await bootOwnerGateway();

    const reply = await gateway!.handleTestMessage(SECONDARY_CHAT, 'severe chest pain right now');

    expect(reply).toBe(EMERGENCY_RESPONSE);
    expect(defaultAgent).not.toHaveBeenCalled();
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'severe chest pain')).toEqual([]);
    expect(await defaultRuntime.ledgerStore!.listAllOfType('medication')).toEqual([]);
  });

  it('staged media in an UNBOUND chat is REFUSED and deleted — never adopted into any reports directory', async () => {
    const { defaultRuntime } = await bootOwnerGateway();
    const staging = path.join(defaultRuntime.workspace, '.state', 'media-staging');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const stagedPath = path.join(staging, 'lab-report.pdf');
    fs.writeFileSync(stagedPath, 'secondary lab bytes', { mode: 0o600 });

    const router = new GatewayMessageRouter({
      config: makeConfig(),
      admission: (gateway as unknown as { admission: never }).admission,
      ownerId: 'default' as ProfileId,
      stagingDir: staging,
      stagingBaseDir: defaultRuntime.workspace,
      buildBootStatusText: () => 'status',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveRuntime: ((id: ProfileId) => gateway!.runtimeManager!.get(id)) as any,
    } as never);
    const reply = await router.route(
      { chatId: SECONDARY_CHAT, userId: '', text: `analyze this ${SECONDARY_MARKER}`, mediaPath: stagedPath },
      jest.fn().mockResolvedValue(undefined),
    );

    expect(reply).toMatch(/not connected to this assistant/i);
    expect(fs.existsSync(stagedPath)).toBe(false);
    const reportsDir = path.join(defaultRuntime.workspace, 'reports');
    const adoptedNames = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : [];
    expect(adoptedNames).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'secondary lab bytes')).toEqual([]);
  });

  it('the owner runtime carries a scheduler, and job creation for an unbound chat is refused up front', async () => {
    const { defaultRuntime } = await bootOwnerGateway();

    expect(defaultRuntime.scheduler).toBeDefined();

    await expect(defaultRuntime.scheduler!.createJob({
      title: 'Father reminder', chatId: SECONDARY_CHAT, cron: '0 8 * * *',
      prompt: 'take your morning pill', source: 'user', kind: 'routine',
    })).rejects.toThrow(/does not own/i);

    expect(await defaultRuntime.scheduler!.listJobs()).toEqual([]);

    const own = await defaultRuntime.scheduler!.createJob({
      title: 'Owner reminder', chatId: DEFAULT_CHAT, cron: '0 9 * * *',
      prompt: 'take your morning pill', source: 'user', kind: 'routine',
    });
    expect(own.chatId).toBe(DEFAULT_CHAT);
    expect(await defaultRuntime.scheduler!.listJobs()).toHaveLength(1);
  });

  it('a fresh unbound chat is refused: no onboarding, no agent, no store writes', async () => {
    const freshChat = 'father-new-chat';
    gateway = await boundGateway(baseDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const defaultRuntime = await gateway.runtimeManager!.get('default' as ProfileId);
    const run = jest.fn().mockResolvedValue({ text: 'SHOULD-NOT-RUN', trace: [], usedTools: [], healthResponse: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run };

    const reply = await gateway.handleTestMessage(freshChat, 'hello, I am setting up');

    expect(reply).toMatch(/not connected to this assistant/i);
    expect(reply).not.toBe('SHOULD-NOT-RUN');
    expect(run).not.toHaveBeenCalled();
    expect(defaultRuntime.sessions!.getHistory(freshChat)).toEqual([]);
    expect(fs.existsSync(path.join(defaultRuntime.workspace, '.redacted', 'onboarding.json'))).toBe(false);
  });

  it('the bound owner is served and every other chat is refused', async () => {
    gateway = await boundGateway(baseDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const defaultRuntime = await gateway.runtimeManager!.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    const ownerAgent = mockAgentRun(`default-ack ${DEFAULT_MARKER}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: ownerAgent };

    const ownerReply = await gateway.handleTestMessage(DEFAULT_CHAT, 'hello');
    expect(ownerReply).toContain(DEFAULT_MARKER);

    const strangerReply = await gateway.handleTestMessage('stranger-chat', 'show me the health profile');
    expect(strangerReply).toMatch(/not connected to this assistant/i);

    fs.mkdirSync(path.join(baseDir), { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, 'profiles.json'),
      JSON.stringify({ profiles: [{ profileId: 'father', label: 'father', chatIds: [SECONDARY_CHAT] }] }),
    );
    const secondaryReply = await gateway.handleTestMessage(SECONDARY_CHAT, 'hello father scope');
    expect(secondaryReply).toMatch(/not connected to this assistant/i);
    expect(secondaryReply).not.toContain(SECONDARY_MARKER);

    expect(ownerAgent).toHaveBeenCalledTimes(1);
  });

  it('a degraded (unresolvable) profile gets a canned genuine-failure reply — never a throw, staged media cleaned up', async () => {
    const staging = path.join(baseDir, 'profiles', 'default', '.state', 'media-staging');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const mkStaged = (name: string): string => {
      const p = path.join(staging, name);
      fs.writeFileSync(p, 'degraded bytes', { mode: 0o600 });
      return p;
    };
    for (const resolveRuntime of [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => Promise.resolve(undefined)) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => Promise.reject(new Error('simulated corrupt profile build'))) as any,
    ]) {
      const stagedPath = mkStaged(`upload-${Math.random().toString(36).slice(2)}.pdf`);
      const bound = await bindOwnerFixture(
        path.join(baseDir, 'profiles', 'default', '.state', 'owner-access.json'),
        'default',
        DEFAULT_CHAT,
        { channel: 'telegram', userId: 'owner-user' },
      );
      const router = new GatewayMessageRouter({
        config: makeConfig(),
        admission: bound.admission,
        ownerId: bound.ownerId,
        stagingDir: staging,
        stagingBaseDir: path.join(baseDir, 'profiles', 'default'),
        buildBootStatusText: () => 'status',
        resolveRuntime,
      } as never);
      const reply = await router.route(
        {
          channel: 'telegram',
          chatId: DEFAULT_CHAT,
          userId: 'owner-user',
          chatType: 'private',
          eventId: 'telegram:degraded:1',
          text: 'hello',
          mediaPath: stagedPath,
        },
        jest.fn().mockResolvedValue(undefined),
      );
      expect(reply).toContain('temporarily unavailable');
      expect(reply).not.toContain("can't serve");
      expect(fs.existsSync(stagedPath)).toBe(false);
    }
  });
});
