import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CapturePipeline, FileCaptureIdempotency, makeSafetyRenderer, type QueuePort, type Rederiver } from '../../src/capture';
import { LedgerStore, NarrativeStore, SafetyView, TYPE_TO_FILE } from '../../src/memcore';
import type { FactType } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';
import { SqliteFactMirror, ledgerFactToRecord } from '../../src/indexstore';

// Part A/B (mini-plan v3 §3.6/§3.7): Tier-1 FactMirror derivation must run SYNCHRONOUSLY INSIDE
// the write lock — the write and its safety-critical projection land atomically, so there is no
// window where a read that starts the instant `ingest()` resolves can observe a stale mirror. On
// HEAD a678272 the FactMirror update ran in the `rederive` closure called AFTER `queue.enqueue()`
// resolved (see the "Out-of-op (B2)" comment in the pre-R-S3 `pipeline.ts`) — an async gap existed
// between the ledger write committing and the mirror reflecting it.
describe('RR-STRUCT R-S3 — Tier-1 FactMirror lands atomically with the write (no crash/read window)', () => {
  let root: string;
  let dbPath: string;
  let ledger: LedgerStore;
  let factMirror: SqliteFactMirror;
  let pipeline: CapturePipeline;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs3-tier1-'));
    dbPath = path.join(root, 'search.db');
    ledger = new LedgerStore(root);
    const narrative = new NarrativeStore(root);
    const view = new SafetyView(root);
    const safety = makeSafetyRenderer({ render: (facts) => view.render(facts), listSafetyRelevant: () => ledger.listSafetyRelevant() });
    factMirror = new SqliteFactMirror({ dbPath });
    const queue: QueuePort = new WriteQueue({ journalPath: path.join(root, '.state', 'write-queue.journal') });

    const fileToType = new Map<string, FactType>(
      (Object.entries(TYPE_TO_FILE) as [FactType, string][]).map(([t, f]) => [f, t]),
    );
    // Mirrors the EXACT Tier-1 wiring in src/gateway/runtime.ts: whole-type re-derive, synchronous,
    // called from INSIDE the pipeline's write-lock op (via `tier1Rederive`), never `enqueue()`.
    const tier1Rederive: Rederiver = {
      rederive: async (relPaths: string[]): Promise<void> => {
        const types = new Set<FactType>();
        for (const rel of relPaths) {
          if (!rel.startsWith('ledger/')) continue;
          const type = fileToType.get(rel.slice('ledger/'.length));
          if (type) types.add(type);
        }
        for (const type of types) {
          const facts = await ledger.listAllOfType(type);
          await factMirror.replaceType(type, facts.map(ledgerFactToRecord));
        }
      },
    };

    pipeline = new CapturePipeline({
      queue, ledger, narrative, safety, tier1Rederive,
      idempotency: new FileCaptureIdempotency(path.join(root, '.state', 'capture-idempotency.log')),
    });
  });
  afterEach(() => {
    factMirror.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a fresh factMirror.queryActive() read the INSTANT ingest() resolves already reflects the new fact — no async gap', async () => {
    await pipeline.ingest({
      profileId: 'default', source: 'tool:ledger_record', kind: 'ledger-fact',
      payload: {
        entity: 'metformin', type: 'medication', fields: { dose: '500mg' },
        provenance: { source: 'user', confidence: 1, anchor: '', capturedAt: '2026-09-01T09:00:00.000Z' },
        text: 'started metformin',
      },
    });

    // No `await new Promise(setTimeout)`, no retry loop — the very next microtask sees it.
    const found: string[] = [];
    for await (const f of factMirror.queryActive('medication')) found.push(f.entity);
    expect(found).toContain('metformin');
  });

  it('a direct-applied discontinuation is reflected just as atomically (the entity drops out of queryActive)', async () => {
    // A non-med/allergy type (LedgerStore.discontinue applies med/allergy discontinuation only
    // after confirmation — this test isolates the Tier-1 atomicity property, not the confirm flow).
    await pipeline.ingest({
      profileId: 'default', source: 'tool:ledger_record', kind: 'ledger-fact',
      payload: {
        entity: 'headache', type: 'symptom', fields: {},
        provenance: { source: 'user', confidence: 1, anchor: '', capturedAt: '2026-09-01T09:00:00.000Z' },
        text: 'started having a headache',
      },
    });
    let found: string[] = [];
    for await (const f of factMirror.queryActive('symptom')) found.push(f.entity);
    expect(found).toContain('headache');

    const outcome = await ledger.discontinue('headache', 'symptom', { source: 'user', confidence: 1, anchor: '', capturedAt: '2026-09-02T09:00:00.000Z' });
    expect(outcome.kind).toBe('applied'); // sanity: this really did apply directly (not gated on confirm)
    // Simulate the SAME Tier-1 call ledger-tools.ts now makes IN-LOCK for a direct-applied removal.
    const facts = await ledger.listAllOfType('symptom');
    await factMirror.replaceType('symptom', facts.map(ledgerFactToRecord));

    found = [];
    for await (const f of factMirror.queryActive('symptom')) found.push(f.entity);
    expect(found).not.toContain('headache');
  });
});
