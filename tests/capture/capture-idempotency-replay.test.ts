import * as fs from 'fs';
import * as path from 'path';
import { CapturePipeline, FileCaptureIdempotency, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { LedgerStore, NarrativeStore, SafetyView } from '../../src/memcore';
import type { RecordFactResult } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';
import { makeTestTemp } from '../helpers/test-temp';

function expectApplied(r: RecordFactResult | void): Extract<RecordFactResult, { kind: 'applied' }> {
  if (!r || r.kind !== 'applied') throw new Error(`expected an applied result, got: ${JSON.stringify(r)}`);
  return r;
}
function expectNeedsConfirmation(r: RecordFactResult | void): Extract<RecordFactResult, { kind: 'needs-confirmation' }> {
  if (!r || r.kind !== 'needs-confirmation') throw new Error(`expected a needs-confirmation result, got: ${JSON.stringify(r)}`);
  return r;
}

describe('idempotency cache-return', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('redacted-idem-');
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

    const second = expectApplied(await pipeline.ingest(event));
    expect(second.fact.id).toBe(first.fact.id);
  });

  it('the cached result survives a simulated process restart (a NEW CapturePipeline reading the same durable marker)', async () => {
    const first = expectApplied(await makePipeline().ingest(event));
    const second = expectApplied(await makePipeline().ingest(event));
    expect(second.fact.id).toBe(first.fact.id);

    const ledger = new LedgerStore(root);
    expect(await ledger.listAllOfType('medication')).toHaveLength(1);
  });

  it('a needs-confirmation result (not just applied) is also cached and replayed verbatim', async () => {
    const pipeline = makePipeline();
    const ledger = new LedgerStore(root);
    await ledger.recordFact({
      entity: 'metformin', type: 'medication', fields: { dose: '250mg' },
      provenance: { source: 'user', confidence: 1, anchor: '', capturedAt: '2026-08-31T09:00:00.000Z' },
    });

    const first = expectNeedsConfirmation(await pipeline.ingest(event));
    const second = expectNeedsConfirmation(await pipeline.ingest(event));
    expect(second.token.uuid).toBe(first.token.uuid);
  });
});
