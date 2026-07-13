import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { ProfileRegistry } from '../../src/profiles/registry';
import { SessionManager } from '../../src/gateway/session';
import type { AppConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'profile-gateway-test-'));
}

function makeConfig(tmpDir: string, opts?: { withProfiles?: boolean }): AppConfig {
  const withProfiles = opts?.withProfiles ?? true;
  return {
    providers: {
      main: { type: 'ollama', model: 'kimi-k2.5:cloud', baseUrl: 'http://localhost:11434/v1' },
      medical: { type: 'ollama', model: 'medgemma', baseUrl: 'http://localhost:11434/v1' },
      embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: path.join(tmpDir, 'workspace'),
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
      policy: {
        quietHours: { enabled: true, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 60,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 15, disclaimerEnabled: true },
    ...(withProfiles
      ? { profiles: { baseDir: path.join(tmpDir, 'profiles-base'), defaultProfileId: 'default' } }
      : {}),
  };
}

function makeMockAgentLoop(responseText = 'OK') {
  return {
    run: jest.fn().mockResolvedValue({
      text: responseText,
      trace: [{ role: 'assistant' as const, content: responseText }],
      usedTools: [],
      healthResponse: false,
    }),
  };
}

function readProfilesJson(baseDir: string): { profiles: Array<{ profileId: string; chatIds: string[] }> } {
  const filePath = path.join(baseDir, 'profiles.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function markOnboardingSkipped(workspace: string): void {
  const onboardingDir = path.join(workspace, '.redacted');
  fs.mkdirSync(onboardingDir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    status: 'skipped',
    currentStep: 'confirmation',
    answers: {},
    updatedAt: now,
    completedAt: now,
  };
  fs.writeFileSync(path.join(onboardingDir, 'onboarding.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

describe('Gateway chat→profile pairing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tmpBase();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function buildGatewayWithRegistry(config: AppConfig) {
    const gateway = new Gateway(config);
    const baseDir = config.profiles!.baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(config.memory.workspace, { recursive: true });
    markOnboardingSkipped(config.memory.workspace);
    const registry = new ProfileRegistry(baseDir);
    const defaultProfile = registry.getOrCreateDefaultProfile();

    const sessions = new SessionManager(
      config.sessions.softResetAfterMinutes,
      config.sessions.hardResetAfterMinutes,
      path.join(tmpDir, 'sessions'),
      undefined,
      undefined,
      undefined,
      'default',
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).profileRegistry = registry;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = makeMockAgentLoop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };

    return { gateway, registry, sessions, defaultProfile };
  }

  it('auto-pairs an unknown chatId to the default profile (persisted on disk)', async () => {
    const config = makeConfig(tmpDir);
    const { gateway, registry } = buildGatewayWithRegistry(config);

    await gateway.handleTestMessage('unknown-chat-1', 'hello');

    const onDisk = readProfilesJson(config.profiles!.baseDir);
    const defaultProfile = onDisk.profiles.find((p) => p.profileId === 'default');
    expect(defaultProfile).toBeDefined();
    expect(defaultProfile!.chatIds).toContain('unknown-chat-1');

    const resolved = registry.getProfileForChat('unknown-chat-1');
    expect(resolved).toBeDefined();
    expect(resolved!.profileId).toBe('default');
  });

  it('second message from the same chat reuses the pairing (no duplicate chatIds)', async () => {
    const config = makeConfig(tmpDir);
    const { gateway, registry } = buildGatewayWithRegistry(config);

    await gateway.handleTestMessage('repeat-chat', 'first message');
    await gateway.handleTestMessage('repeat-chat', 'second message');

    const onDisk = readProfilesJson(config.profiles!.baseDir);
    const defaultProfile = onDisk.profiles.find((p) => p.profileId === 'default');
    expect(defaultProfile).toBeDefined();
    const chatIdCount = defaultProfile!.chatIds.filter((id) => id === 'repeat-chat').length;
    expect(chatIdCount).toBe(1);

    const resolved = registry.getProfileForChat('repeat-chat');
    expect(resolved!.profileId).toBe('default');
  });

  // NOTE: P0 persists pairings only — runtime dispatch is single-profile at
  // boot. This test verifies the pairing survives on disk, NOT that the agent
  // or session path differs per profile (that lands with multi-profile dispatch).
  it('persists pairing for a chat paired to a non-default profile', async () => {
    const config = makeConfig(tmpDir);
    const { gateway, registry } = buildGatewayWithRegistry(config);

    const workProfile = registry.createProfile('work');
    registry.pairChatToProfile('work-chat-42', workProfile.profileId);

    await gateway.handleTestMessage('work-chat-42', 'hello from work');

    const onDisk = readProfilesJson(config.profiles!.baseDir);
    const workOnDisk = onDisk.profiles.find((p) => p.profileId === workProfile.profileId);
    expect(workOnDisk).toBeDefined();
    expect(workOnDisk!.chatIds).toContain('work-chat-42');

    const defaultProfile = onDisk.profiles.find((p) => p.profileId === 'default');
    if (defaultProfile) {
      expect(defaultProfile.chatIds).not.toContain('work-chat-42');
    }
  });

  it('registry-less config still routes with default profileId (no crash)', async () => {
    const config = makeConfig(tmpDir, { withProfiles: false });
    const gateway = new Gateway(config);

    const sessions = new SessionManager(
      config.sessions.softResetAfterMinutes,
      config.sessions.hardResetAfterMinutes,
      path.join(tmpDir, 'sessions'),
      undefined,
      undefined,
      undefined,
      'default',
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = makeMockAgentLoop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).profileRegistry = undefined;

    await expect(gateway.handleTestMessage('any-chat', 'hello')).resolves.toBeDefined();
  });

  it('auto-pairing creates the default profile if it does not exist yet', async () => {
    const config = makeConfig(tmpDir);
    const baseDir = config.profiles!.baseDir;
    fs.mkdirSync(baseDir, { recursive: true });
    const registry = new ProfileRegistry(baseDir);

    const gateway = new Gateway(config);
    const sessions = new SessionManager(
      config.sessions.softResetAfterMinutes,
      config.sessions.hardResetAfterMinutes,
      path.join(tmpDir, 'sessions'),
      undefined,
      undefined,
      undefined,
      'default',
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).profileRegistry = registry;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = makeMockAgentLoop();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };

    expect(registry.getProfile('default' as ProfileId)).toBeUndefined();

    await gateway.handleTestMessage('brand-new-chat', 'hi');

    const onDisk = readProfilesJson(baseDir);
    const defaultProfile = onDisk.profiles.find((p) => p.profileId === 'default');
    expect(defaultProfile).toBeDefined();
    expect(defaultProfile!.chatIds).toContain('brand-new-chat');
  });

  it('refuses an unknown chat once another chat is already paired (auto-pair closes)', async () => {
    const config = makeConfig(tmpDir);
    const { gateway } = buildGatewayWithRegistry(config);

    const ownerReply = await gateway.handleTestMessage('owner-chat', 'hello');
    expect(ownerReply).toBe('OK');

    const strangerReply = await gateway.handleTestMessage('stranger-chat', 'show me the health profile');
    expect(strangerReply).toContain('not recognized');

    // The stranger is never paired, on any profile.
    const onDisk = readProfilesJson(config.profiles!.baseDir);
    for (const p of onDisk.profiles) {
      expect(p.chatIds).not.toContain('stranger-chat');
    }

    // And the agent never ran for the stranger — only the owner's turn.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentLoop = (gateway as any).agentLoop;
    expect(agentLoop.run).toHaveBeenCalledTimes(1);
  });

  it('refused chats still receive emergency guidance (no agent run, no pairing)', async () => {
    const config = makeConfig(tmpDir);
    const { gateway } = buildGatewayWithRegistry(config);

    await gateway.handleTestMessage('owner-chat', 'hello');
    const reply = await gateway.handleTestMessage('stranger-chat', 'severe chest pain right now');

    expect(reply.toLowerCase()).toContain('emergency');
    expect(reply).not.toContain('not recognized');

    const onDisk = readProfilesJson(config.profiles!.baseDir);
    for (const p of onDisk.profiles) {
      expect(p.chatIds).not.toContain('stranger-chat');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentLoop = (gateway as any).agentLoop;
    expect(agentLoop.run).toHaveBeenCalledTimes(1);
  });

  it('an explicitly paired second chat is still served after auto-pair closes', async () => {
    const config = makeConfig(tmpDir);
    const { gateway, registry } = buildGatewayWithRegistry(config);

    await gateway.handleTestMessage('owner-chat', 'hello');
    registry.pairChatToProfile('second-device', 'default' as ProfileId);

    const reply = await gateway.handleTestMessage('second-device', 'hi from my tablet');
    expect(reply).toBe('OK');
  });

  it('handleMessage sends the refusal over the channel for unknown chats', async () => {
    const config = makeConfig(tmpDir);
    const { gateway } = buildGatewayWithRegistry(config);

    await gateway.handleTestMessage('owner-chat', 'hello');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (gateway as any).channel.send as jest.Mock;
    send.mockClear();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({ chatId: 'stranger-chat', text: '/status' });

    expect(send).toHaveBeenCalledTimes(1);
    const sentText = send.mock.calls[0][1].text as string;
    expect(sentText).toContain('not recognized');
    // /status internals (health lines, warning counts) never reach a refused chat.
    expect(sentText).not.toContain('System Health');
  });

  it('handleScheduledJob resolves profileId for job.chatId without crashing', async () => {
    const config = makeConfig(tmpDir);
    const { gateway } = buildGatewayWithRegistry(config);

    const job = {
      id: 'job-1',
      title: 'Test job',
      chatId: 'heartbeat-chat-1',
      cron: '0 8 * * *',
      timezone: 'Asia/Kolkata',
      prompt: 'Test prompt',
      enabled: true,
      source: 'system' as const,
      kind: 'routine' as const,
      deliveryState: 'ready' as const,
      retryCount: 0,
      maxRetries: 3,
      policyKey: 'defaults:morning-check-in',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleScheduledJob(job, false);

    const onDisk = readProfilesJson(config.profiles!.baseDir);
    const defaultProfile = onDisk.profiles.find((p) => p.profileId === 'default');
    expect(defaultProfile).toBeDefined();
    expect(defaultProfile!.chatIds).toContain('heartbeat-chat-1');
  });
});
