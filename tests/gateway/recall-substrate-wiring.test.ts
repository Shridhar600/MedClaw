import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { MemoryIndexer } from '../../src/memory/indexer';
import type { AppConfig } from '../../src/config/types';
import type { FactRecord } from '../../src/ports';

// P2 Wave A — the recall substrate wired behind the live Gateway: every ledger write live-populates
// the FactMirror (recall Stage 1 source) and reindexes the changed file (M-2 closed), and the mirror
// is rebuilt from Markdown at boot (A4 self-heal). Re-derivation runs OUTSIDE the write-queue op (B2).

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

async function collectActive(gateway: Gateway, type?: string): Promise<FactRecord[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mirror = (gateway as any).factMirror;
  const out: FactRecord[] = [];
  for await (const f of mirror.queryActive(type)) out.push(f);
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registryOf = (gateway: Gateway): any => (gateway as any).agentLoop.registry;

describe('Gateway recall substrate wiring (P2 Wave A)', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-recall-sub-'));
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    warn.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('live-populates the FactMirror on a ledger write and reindexes the changed files (M-2)', async () => {
    const indexFileSpy = jest.spyOn(MemoryIndexer.prototype, 'indexFile');
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();
    indexFileSpy.mockClear(); // ignore the boot indexAll's calls; assert only the post-write ones

    const res = await registryOf(gateway).execute('ledger_record', {
      entity: 'metformin', type: 'medication', fields: { dose: '500mg' },
      safetyRelevant: true, note: 'started metformin 500mg',
    });
    expect(res.isError).toBeFalsy();

    // Recall Stage 1 source is live — no reboot needed (M-2 closed for the ledger lane).
    const meds = await collectActive(gateway, 'medication');
    const metformin = meds.find(f => f.entity === 'metformin');
    expect(metformin).toBeDefined();
    expect(metformin!.status).toBe('active');
    expect(metformin!.safetyRelevant).toBe(true);
    expect(metformin!.authority).toBe('user'); // ledger_record default provenance
    expect(metformin!.fields).toMatchObject({ dose: '500mg' });

    // The changed ledger + narrative files were reindexed after the write (embeds off the write lock).
    const reindexed = indexFileSpy.mock.calls.map(c => c[0]);
    expect(reindexed).toEqual(expect.arrayContaining(['ledger/medications.md']));
    expect(reindexed.some(p => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(p))).toBe(true);

    indexFileSpy.mockRestore();
  });

  it('rebuilds the FactMirror from ledger Markdown at boot (A4 self-heal)', async () => {
    // First daemon writes a fact, then stops.
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();
    await registryOf(gateway).execute('ledger_record', {
      entity: 'lisinopril', type: 'medication', fields: { dose: '10mg' }, note: 'started lisinopril',
    });
    await gateway.stop();

    // A fresh daemon over the SAME workspace rebuilds the mirror from Markdown at boot — the fact
    // is queryable without any new write (proves the mirror is derived state, not the source).
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();
    const meds = await collectActive(gateway, 'medication');
    expect(meds.map(f => f.entity)).toContain('lisinopril');
  });
});
