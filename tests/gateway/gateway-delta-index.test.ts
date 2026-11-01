import * as fs from 'fs';
import * as path from 'path';

import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import type { LLMProvider } from '../../src/providers/types';
import type { ToolRegistry } from '../../src/tools/registry';
import { fixtureOwner, ownerSelection } from '../helpers/test-config';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';
import { makeTestTemp } from '../helpers/test-temp';
import { ownerTools } from '../helpers/owner-tools';

const CHAT_BINDING = 'owner-chat';

const mockProvider: LLMProvider = {
  modelName: 'delta-gateway',
  chat: jest.fn().mockResolvedValue({ type: 'text', text: 'ok' }),
  embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

jest.mock('../../src/providers/factory', () => ({
  createProvider: jest.fn(() => mockProvider),
}));

function makeConfig(workspace: string): EffectiveConfig {
const owner = fixtureOwner(workspace);
  return {
  schemaVersion: 2,
  ...ownerSelection(owner),
    providers: {
      main: { type: 'ollama', model: 'delta-main', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'delta-medical', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'delta-embedding', baseUrl: 'http://127.0.0.1:9/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace,
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20_000,
    },
    sessions: {
      compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 },
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
    agent: { maxIterations: 5 },
  };
}

function registryOf(gateway: Gateway): ReturnType<typeof ownerTools> {
  const state = gateway as unknown as { agentLoop?: { registry: ToolRegistry } };
  if (!state.agentLoop) throw new Error('Gateway agent loop is not initialized');
  return ownerTools(state.agentLoop.registry);
}

describe('Gateway delta wiring', () => {
  let tmpDir: string;
  let gateway: Gateway;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-gateway-');
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

    gateway = new Gateway(makeConfig(workspace), await bindGatewayOwner(makeConfig(workspace), CHAT_BINDING));
    await gateway.start();
    (mockProvider.embed as jest.Mock).mockClear();

    const result = await registryOf(gateway).execute('ledger_record', {
      entity: 'headache',
      type: 'symptom',
      fields: { severity: 'mild' },
      note: 'delta foreground marker',
    });
    expect(result.isError).toBeFalsy();
    await (gateway as unknown as { drainBackgroundOperations(): Promise<void> }).drainBackgroundOperations();

    const store = (gateway as unknown as {
      store: { getChunksByPath(relativePath: string): Array<{ id: string }> };
    }).store;
    const chunks = store.getChunksByPath(`memory/${day}.md`);
    expect(chunks.some(chunk => chunk.id.includes(':delta:'))).toBe(true);
    expect(mockProvider.embed).toHaveBeenCalledTimes(3);
  });

  it('replaces only the changed FactMirror type/entity scope after a ledger capture', async () => {
    const workspace = path.join(tmpDir, 'workspace');
    gateway = new Gateway(makeConfig(workspace), await bindGatewayOwner(makeConfig(workspace), CHAT_BINDING));
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
