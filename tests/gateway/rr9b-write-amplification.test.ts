import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';
import type { LLMProvider } from '../../src/providers/types';
import type { ToolRegistry } from '../../src/tools/registry';

const mockProvider: LLMProvider = {
  modelName: 'rr9b-gateway',
  chat: jest.fn().mockResolvedValue({ type: 'text', text: 'ok' }),
  embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

jest.mock('../../src/providers/factory', () => ({
  createProvider: jest.fn(() => mockProvider),
}));

function makeConfig(workspace: string): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'rr9b-main', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'rr9b-medical', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'rr9b-embedding', baseUrl: 'http://127.0.0.1:9/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace,
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20_000,
    },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: path.join(workspace, '.state', 'heartbeats.json'),
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: path.join(workspace, '.state', 'heartbeat-audit.jsonl') },
      policy: {
        quietHours: { enabled: false, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 0,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 5, disclaimerEnabled: false },
  };
}

function registryOf(gateway: Gateway): ToolRegistry {
  const state = gateway as unknown as { agentLoop?: { registry: ToolRegistry } };
  if (!state.agentLoop) throw new Error('Gateway agent loop is not initialized');
  return state.agentLoop.registry;
}

describe('RR-9b Gateway delta wiring', () => {
  let tmpDir: string;
  let gateway: Gateway;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9b-gateway-'));
    jest.clearAllMocks();
  });

  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* cleanup must not mask the assertion */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes only the appended narrative delta after a large existing day file', async () => {
    const workspace = path.join(tmpDir, 'workspace');
    const day = new Date().toISOString().slice(0, 10);
    const dayPath = path.join(workspace, 'memory', `${day}.md`);
    fs.mkdirSync(path.dirname(dayPath), { recursive: true });
    fs.writeFileSync(dayPath, Array.from({ length: 900 }, (_, index) => `history-${index} ${'stable '.repeat(8)}`).join('\n') + '\n');

    gateway = new Gateway(makeConfig(workspace));
    await gateway.start();
    (mockProvider.embed as jest.Mock).mockClear();

    const result = await registryOf(gateway).execute('ledger_record', {
      entity: 'headache',
      type: 'symptom',
      fields: { severity: 'mild' },
      note: 'rr9b foreground marker',
    });
    expect(result.isError).toBeFalsy();
    await (gateway as unknown as { drainBackgroundOperations(): Promise<void> }).drainBackgroundOperations();

    const store = (gateway as unknown as {
      store: { getChunksByPath(relativePath: string): Array<{ id: string }> };
    }).store;
    const chunks = store.getChunksByPath(`memory/${day}.md`);
    expect(chunks.some(chunk => chunk.id.includes(':delta:'))).toBe(true);
    // One capture adds a narrative entry, its narrative cross-anchor, and the
    // ledger fact block. Those three source deltas are the only post-start
    // embeddings; a full reindex would embed all history chunks too.
    expect(mockProvider.embed).toHaveBeenCalledTimes(3);
  });

  it('replaces only the changed FactMirror type/entity scope after a ledger capture', async () => {
    const workspace = path.join(tmpDir, 'workspace');
    gateway = new Gateway(makeConfig(workspace));
    await gateway.start();

    const mirror = (gateway as unknown as {
      factMirror: { replaceScope: jest.Mock; replaceType: jest.Mock };
    }).factMirror;
    const replaceScope = jest.spyOn(mirror, 'replaceScope');
    const replaceType = jest.spyOn(mirror, 'replaceType');

    const result = await registryOf(gateway).execute('ledger_record', {
      entity: 'headache',
      type: 'symptom',
      fields: { severity: 'mild' },
      note: 'scope marker',
    });
    expect(result.isError).toBeFalsy();
    await (gateway as unknown as { drainBackgroundOperations(): Promise<void> }).drainBackgroundOperations();

    expect(replaceScope).toHaveBeenCalledWith('symptom', 'headache', expect.any(Array));
    expect(replaceType).not.toHaveBeenCalled();
  });
});
