import * as fs from 'fs';
import { Gateway } from '../../src/gateway/gateway';
import { MemoryIndexer } from '../../src/memory/indexer';
import type { EffectiveConfig } from '../../src/config/types';
import type { FactRecord } from '../../src/ports';
import { fixtureOwner, ownerSelection } from '../helpers/test-config';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';
import { makeTestTemp } from '../helpers/test-temp';
import { ownerTools } from '../helpers/owner-tools';

const CHAT_BINDING = 'owner-chat';

function makeConfig(tmpDir: string): EffectiveConfig {
const owner = fixtureOwner(tmpDir);
  return {
  schemaVersion: 2,
  ...ownerSelection(owner),
    providers: {
      main: { type: 'ollama', model: 'kimi-k2.5:cloud', baseUrl: 'http://localhost:11434/v1' },
      medical: { type: 'ollama', model: 'medgemma', baseUrl: 'http://localhost:11434/v1' },
      embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: owner.workspace,
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: owner.storePath,
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: owner.auditLogPath },
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

async function collectActive(gateway: Gateway, type?: string): Promise<FactRecord[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mirror = (gateway as any).factMirror;
  const out: FactRecord[] = [];
  for await (const f of mirror.queryActive(type)) out.push(f);
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registryOf = (gateway: Gateway): any => ownerTools((gateway as any).agentLoop.registry);

describe('Gateway recall substrate wiring', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-recall-sub-');
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    warn.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('live-populates the FactMirror on a ledger write and reindexes the changed files', async () => {
    const indexFileSpy = jest.spyOn(MemoryIndexer.prototype, 'indexFile');
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    await gateway.start();
    indexFileSpy.mockClear(); // ignore the boot indexAll's calls; assert only the post-write ones

    const res = await registryOf(gateway).execute('ledger_record', {
      entity: 'metformin', type: 'medication', fields: { dose: '500mg' },
      safetyRelevant: true, note: 'started metformin 500mg',
    });
    expect(res.isError).toBeFalsy();

    const meds = await collectActive(gateway, 'medication');
    const metformin = meds.find(f => f.entity === 'metformin');
    expect(metformin).toBeDefined();
    expect(metformin!.status).toBe('active');
    expect(metformin!.safetyRelevant).toBe(true);
    expect(metformin!.authority).toBe('user'); // ledger_record default provenance
    expect(metformin!.fields).toMatchObject({ dose: '500mg' });

    const reindexed = indexFileSpy.mock.calls.map(c => c[0]);
    expect(reindexed).toEqual(expect.arrayContaining(['ledger/medications.md']));
    expect(reindexed.some(p => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(p))).toBe(true);

    indexFileSpy.mockRestore();
  });

  it('rebuilds the FactMirror from ledger Markdown at boot (self-heal)', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    await gateway.start();
    await registryOf(gateway).execute('ledger_record', {
      entity: 'lisinopril', type: 'medication', fields: { dose: '10mg' }, note: 'started lisinopril',
    });
    await gateway.stop();

    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    await gateway.start();
    const meds = await collectActive(gateway, 'medication');
    expect(meds.map(f => f.entity)).toContain('lisinopril');
  });
});
