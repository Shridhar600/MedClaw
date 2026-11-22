import * as fs from 'fs';
import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import {} from '../helpers/test-config';
import { fixtureOwner, ownerSelection } from '../helpers/test-config';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';
import { makeTestTemp } from '../helpers/test-temp';

const CHAT_BINDING = 'owner-chat';

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

describe('Gateway startup resilience', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-gateway-startup-');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function makeConfig(): EffectiveConfig {
    return {
    schemaVersion: 2,
    ...ownerSelection(fixtureOwner(tmpDir)),
      providers: {
        main: { type: 'ollama', model: 'kimi-k2.5:cloud', baseUrl: 'http://localhost:11434/v1' },
        medical: { type: 'ollama', model: 'medgemma', baseUrl: 'http://localhost:11434/v1' },
        embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
      },
      channels: { telegram: { enabled: false, botToken: '' } },
      tools: { allow: ['*'], deny: [] },
      memory: {
        workspace: fixtureOwner(tmpDir).workspace,
        search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
        bootstrapMaxChars: 20000,
      },
      sessions: {
        compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 },
      },
      heartbeat: {
        enabled: false,
        timezone: 'Asia/Kolkata',
        storePath: fixtureOwner(tmpDir).storePath,
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: fixtureOwner(tmpDir).auditLogPath },
        policy: {
          quietHours: { enabled: true, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
          defaults: {
            morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
            eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
          },
        },
      },
      agent: { maxIterations: 15 },
    };
  }

  it('continues startup when the initial memory index build fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), CHAT_BINDING));

    await expect(gateway.start()).resolves.toBeUndefined();
    await gateway.stop();

    expect(warn.mock.calls.flat().join('\n')).toContain('Memory index unavailable');
    expect(warn.mock.calls.flat().join('\n')).toContain('Error (at ');
    expect(warn.mock.calls.flat().join('\n')).not.toContain('embedding provider unavailable');
  });
});
