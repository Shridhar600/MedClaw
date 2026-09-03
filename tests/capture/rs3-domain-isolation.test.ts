import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CapturePipeline, FileCaptureIdempotency, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { LedgerStore, NarrativeStore, SafetyView } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';

// RED item #7 / mini-plan v3 §3.7: generations are CONTENT-HASH and DOMAIN-SCOPED
// (`ledgerGeneration`/`narrativeGeneration`/`sessionGeneration`) — SAFETY depends ONLY on
// `ledgerGeneration`, so a narrative-only mutation must never invalidate or abort it. This is a
// REGRESSION LOCK (the property already held pre-R-S3, via `SafetyView.generationFor(facts)`
// hashing the safety-relevant FACT set only, never narrative bytes) — verified end-to-end through
// the coordinator-routed CapturePipeline this slice generalizes everything else onto.
describe('RR-STRUCT R-S3 — domain isolation: narrative-only writes never touch SAFETY', () => {
  let root: string;
  let ledger: LedgerStore;
  let view: SafetyView;
  let pipeline: CapturePipeline;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs3-isolation-'));
    ledger = new LedgerStore(root);
    const narrative = new NarrativeStore(root);
    view = new SafetyView(root, undefined, () => ledger.listSafetyRelevant());
    const safety = makeSafetyRenderer({
      render: (facts) => view.render(facts),
      listSafetyRelevant: () => ledger.listSafetyRelevant(),
    });
    const queue: QueuePort = new WriteQueue({ journalPath: path.join(root, '.state', 'write-queue.journal') });
    pipeline = new CapturePipeline({
      queue, ledger, narrative, safety,
      idempotency: new FileCaptureIdempotency(path.join(root, '.state', 'capture-idempotency.log')),
    });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a narrative-note capture does not mark SAFETY dirty and does not change its rendered content', async () => {
    await ledger.recordFact({
      entity: 'penicillin', type: 'allergy', fields: {}, safetyRelevant: true,
      provenance: { source: 'user', confidence: 1, anchor: '', capturedAt: '2026-09-01T09:00:00.000Z' },
    });
    await view.render(await ledger.listSafetyRelevant());
    const before = await view.read();
    expect(before).toContain('penicillin');

    await pipeline.ingest({
      profileId: 'default', source: 'chat', kind: 'narrative-note',
      payload: { text: 'felt a bit tired today, nothing unusual' },
    });

    // SAFETY must still read cleanly (not dirty/thrown) and be byte-identical — a narrative write
    // touched a completely different domain (narrativeGeneration), never ledgerGeneration.
    const after = await view.read();
    expect(after).toBe(before);
  });

  it('repeated narrative-note captures never accumulate SAFETY dirty markers (no cross-domain leak over multiple writes)', async () => {
    await ledger.recordFact({
      entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, safetyRelevant: true,
      provenance: { source: 'user', confidence: 1, anchor: '', capturedAt: '2026-09-01T09:00:00.000Z' },
    });
    await view.render(await ledger.listSafetyRelevant());

    for (let i = 0; i < 5; i++) {
      await pipeline.ingest({
        profileId: 'default', source: 'chat', kind: 'narrative-note',
        payload: { text: `day ${i} note about something unrelated to health facts` },
      });
    }

    await expect(view.read()).resolves.toContain('metformin');
  });

  it('a ledger-fact (safety-relevant) capture DOES change SAFETY — the isolation is domain-scoped, not a blanket freeze', async () => {
    const before = await view.read();
    expect(before).toBeNull(); // nothing recorded yet

    await pipeline.ingest({
      profileId: 'default', source: 'chat', kind: 'ledger-fact',
      payload: {
        entity: 'peanuts', type: 'allergy', fields: {},
        provenance: { source: 'user', confidence: 1, anchor: '', capturedAt: '2026-09-01T09:00:00.000Z' },
        safetyRelevant: true,
        text: 'allergic to peanuts',
      },
    });

    await expect(view.read()).resolves.toContain('peanuts');
  });
});
