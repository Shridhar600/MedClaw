import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';

// Wave D-2 — session_search (PLAT-20) wired behind the live Gateway: the SqliteSessionIndex is built on
// the profile search.db, injected into the SessionManager for incremental indexing, and exposed as the
// `session_search` tool group. A turn recorded through the manager is retrievable verbatim via the tool.

function makeConfig(tmpDir: string): AppConfig {
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

describe('Gateway session_search wiring (Wave D-2)', () => {
  let tmpDir: string;
  let gateway: Gateway;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sess-search-wire-'));
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => (gateway as any).agentLoop.registry;

  it('registers the session_search tool group', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore();

    const names = registryOf().getAvailable().map((t: { name: string }) => t.name);
    expect(names).toContain('session_search');
  });

  it('session_search returns a turn recorded through the SessionManager verbatim', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).sessions.recordTurn('chat-x', [
      { role: 'user', content: 'metformin 500mg twice daily' },
    ]);

    const res = await registryOf().execute('session_search', { query: 'metformin 500mg twice daily' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('metformin 500mg twice daily');
    expect(res.content[0].text).toContain('#L1');
  });
});
