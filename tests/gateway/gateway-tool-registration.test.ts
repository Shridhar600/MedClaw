import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';

// RES-P2-1: one tool-group factory failure must NOT crash boot — remaining
// groups still register.
jest.mock('../../src/tools/memory-tools', () => ({
  createMemoryTools: jest.fn(() => {
    throw new Error('memory tools factory blew up PHI marker glucose');
  }),
}));

describe('Gateway boot tool-group degradation (RES-P2-1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-tool-degrade-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function makeConfig(): AppConfig {
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
    };
  }

  it('memory-tools factory failure does not crash boot; medical tools still register, failure warned sanitized', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());

    await expect(gateway.start()).resolves.toBeUndefined();

    // Boot continued despite the memory-tools factory throwing.
    const warned = warn.mock.calls.flat().map(String).join('\n');
    expect(warned).toContain('Memory tools unavailable');
    // PHI marker from the failure message never leaked (summarizeErrorForLog).
    expect(warned).not.toContain('glucose');

    // The medical tool group (which did NOT throw) still registered its tools.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = (gateway as any).agentLoop.registry;
    const available = registry.getAvailable() as Array<{ name: string }>;
    expect(available.length).toBeGreaterThan(0);

    await gateway.stop();
    warn.mockRestore();
    error.mockRestore();
  });
});