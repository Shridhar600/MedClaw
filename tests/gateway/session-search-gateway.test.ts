import * as fs from 'fs';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import {} from '../helpers/test-config';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';
import { makeTestTemp } from '../helpers/test-temp';
import { ownerTools } from '../helpers/owner-tools';

const CHAT_BINDING = 'chat-c';

function makeConfig(tmpDir: string): EffectiveConfig {
  return {
  schemaVersion: 2,
    providers: {
      main: { type: 'ollama', model: 'kimi-k2.5:cloud', baseUrl: 'http://localhost:11434/v1' },
      medical: { type: 'ollama', model: 'medgemma', baseUrl: 'http://localhost:11434/v1' },
      embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    profiles: { baseDir: path.join(tmpDir, 'profiles-base'), defaultProfileId: 'default' },
    memory: {
      workspace: path.join(tmpDir, 'workspace'),
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 },
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
    agent: { maxIterations: 15 },
  };
}

describe('Gateway session_search wiring', () => {
  let tmpDir: string;
  let gateway: Gateway;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-sess-search-wire-');
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => ownerTools((gateway as any).agentLoop.registry);

  it('registers the session_search tool group', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore();

    const names = registryOf().getAvailable().map((t: { name: string }) => t.name);
    expect(names).toContain('session_search');
  });

  it('session_search returns a turn recorded through the SessionManager verbatim', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).sessions.recordTurn('chat-x', [
      { role: 'user', content: 'metformin 500mg twice daily' },
    ]);

    const res = await registryOf().execute('session_search', { query: 'metformin 500mg twice daily' }, { chatId: 'chat-x' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('metformin 500mg twice daily');
    expect(res.content[0].text).toContain('#L1');
  });

  it('the /compact command forces a compaction and confirms', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = jest.spyOn((gateway as any).sessions, 'runCompaction');
    const reply = await gateway.handleTestMessage('chat-c', '/compact');

    expect(spy).toHaveBeenCalledWith('chat-c');
    expect(reply.toLowerCase()).toContain('compacted');
  });
});
