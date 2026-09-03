import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CapturePipeline, FileCaptureIdempotency, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { LedgerStore, NarrativeStore, SafetyView } from '../../src/memcore';
import type { RecordFactResult } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';

function expectApplied(r: RecordFactResult | void): Extract<RecordFactResult, { kind: 'applied' }> {
  if (!r || r.kind !== 'applied') throw new Error(`expected an applied result, got: ${JSON.stringify(r)}`);
  return r;
}
function expectNeedsConfirmation(r: RecordFactResult | void): Extract<RecordFactResult, { kind: 'needs-confirmation' }> {
  if (!r || r.kind !== 'needs-confirmation') throw new Error(`expected a needs-confirmation result, got: ${JSON.stringify(r)}`);
  return r;
}

// RED item #3 / mini-plan v3 §3.6 Finding-5 / C-39: a matched-committed idempotency key must
// return the CACHED ORIGINAL result — not `undefined` — because callers like `ledger_record`
// need the `RecordFactResult` (e.g. to relay a needs-confirmation token) even on a replayed
// delivery. On HEAD a678272, `CapturePipeline.ingest()`'s idempotent-skip branch returns
// `{ result: undefined, changed: [] }` unconditionally — this is the RED baseline this file locks
// closed (see report §Behavior changes for the git-stash RED reproduction transcript).
describe('RR-STRUCT R-S3 — idempotency cache-return (Finding-5/C-39)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs3-idem-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function makePipeline(): CapturePipeline {
    const ledger = new LedgerStore(root);
    const narrative = new NarrativeStore(root);
    const view = new SafetyView(root);
    const safety = makeSafetyRenderer({
      render: (facts) => view.render(facts),
      listSafetyRelevant: () => ledger.listSafetyRelevant(),
    });
    const queue: QueuePort = new WriteQueue({ journalPath: path.join(root, '.state', 'write-queue.journal') });
    return new CapturePipeline({
      queue,
      ledger,
      narrative,
      safety,
      idempotency: new FileCaptureIdempotency(path.join(root, '.state', 'capture-idempotency.log')),
    });
  }

  const event = {
    profileId: 'default',
    source: 'telegram',
    kind: 'ledger-fact' as const,
    idempotencyKey: 'chat:chat-1:msg-42',
    payload: {
      entity: 'metformin',
      type: 'medication' as const,
      fields: { dose: '500mg' },
      provenance: { source: 'user' as const, confidence: 1, anchor: '', capturedAt: '2026-09-01T10:00:00.000Z' },
      text: 'started metformin 500mg',
    },
  };

  it('a replayed idempotencyKey returns the CACHED ORIGINAL RecordFactResult, not undefined', async () => {
    const pipeline = makePipeline();
    const first = expectApplied(await pipeline.ingest(event));
    expect(first.fact.entity).toBe('metformin');

    // The exact defect this closes: this used to be `undefined`.
    const second = expectApplied(await pipeline.ingest(event));
    // Same underlying fact id — the CACHED original, not a freshly re-derived one.
    expect(second.fact.id).toBe(first.fact.id);
  });

  it('the cached result survives a simulated process restart (a NEW CapturePipeline reading the same durable marker)', async () => {
    const first = expectApplied(await makePipeline().ingest(event));
    const second = expectApplied(await makePipeline().ingest(event));
    expect(second.fact.id).toBe(first.fact.id);

    // Still exactly one fact — a lost cache would double-write on the "restarted" replay.
    const ledger = new LedgerStore(root);
    expect(await ledger.listAllOfType('medication')).toHaveLength(1);
  });

  it('a needs-confirmation result (not just applied) is also cached and replayed verbatim', async () => {
    const pipeline = makePipeline();
    // Seed a conflicting active medication so the SAME entity/type mint hits needs-confirmation.
    const ledger = new LedgerStore(root);
    await ledger.recordFact({
      entity: 'metformin', type: 'medication', fields: { dose: '250mg' },
      provenance: { source: 'user', confidence: 1, anchor: '', capturedAt: '2026-08-31T09:00:00.000Z' },
    });

    const first = expectNeedsConfirmation(await pipeline.ingest(event));
    const second = expectNeedsConfirmation(await pipeline.ingest(event));
    // The SAME token is relayed again — a fresh (different) token on replay would let a model
    // confirm using a token that no longer matches the one the user actually saw.
    expect(second.token.uuid).toBe(first.token.uuid);
  });
});
