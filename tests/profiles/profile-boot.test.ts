import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { ProfileRegistry } from '../../src/profiles/registry';
import type { AppConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';

// Deterministic, network-free memory index (mirrors migration-startup.test.ts).
jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

// Plan Task 2.5 gate: Gateway.start() must boot successfully with a
// profile-scoped config and thread the resolved profile workspace through —
// exercised end-to-end via handleTestMessage, not constructor existence checks.
describe('Gateway boot with profiles config (Task 2.5)', () => {
  let tmpDir: string;
  let baseDir: string;
  let legacyWorkspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-profile-boot-'));
    baseDir = path.join(tmpDir, 'redacted-home');
    legacyWorkspace = path.join(tmpDir, 'legacy-workspace');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function makeConfig(): AppConfig {
    return {
      providers: {
        main: { type: 'ollama', model: 'test-model', baseUrl: 'http://localhost:11434/v1' },
        medical: { type: 'ollama', model: 'test-model', baseUrl: 'http://localhost:11434/v1' },
        embeddings: { type: 'ollama', model: 'test-model', baseUrl: 'http://localhost:11434/v1' },
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
        enabled: false,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'legacy-heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'legacy-heartbeats', 'audit.jsonl') },
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
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

  it('boots with a profiles config, resolves the profile-scoped workspace, and serves handleTestMessage', async () => {
    fs.mkdirSync(legacyWorkspace, { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspace, 'SOUL.md'), '# Soul\n', 'utf8');
    // Mark onboarding complete so handleTestMessage reaches the agent loop
    // (the state file migrates into the profile workspace with everything else).
    fs.mkdirSync(path.join(legacyWorkspace, '.redacted'), { recursive: true });
    fs.writeFileSync(
      path.join(legacyWorkspace, '.redacted', 'onboarding.json'),
      JSON.stringify({ status: 'complete', currentStep: 'done', answers: {} }),
      'utf8',
    );

    const gateway = new Gateway(makeConfig());
    await expect(gateway.start()).resolves.toBeUndefined();

    // The resolved workspace must be the registry-derived profile workspace,
    // not the legacy config path.
    const registry = new ProfileRegistry(baseDir);
    const expectedWorkspace = registry.profileWorkspace('default' as ProfileId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gateway as any).resolvedMemoryWorkspace).toBe(expectedWorkspace);
    expect(fs.existsSync(path.join(expectedWorkspace, 'SOUL.md'))).toBe(true);

    // End-to-end turn through the booted gateway (agent mocked: no provider network).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = {
      run: jest.fn().mockResolvedValue({
        text: 'boot-ok',
        trace: [{ role: 'assistant', content: 'boot-ok' }],
        usedTools: [],
        healthResponse: false,
      }),
    };
    const reply = await gateway.handleTestMessage('boot-chat', 'hello after boot');
    expect(reply).toBe('boot-ok');

    // The turn's chat is paired and persisted on disk.
    const onDisk = JSON.parse(fs.readFileSync(path.join(baseDir, 'profiles.json'), 'utf8'));
    const defaultProfile = onDisk.profiles.find((p: { profileId: string }) => p.profileId === 'default');
    expect(defaultProfile.chatIds).toContain('boot-chat');

    await gateway.stop();
  });
});
