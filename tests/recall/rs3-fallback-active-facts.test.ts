import { RecallEngine, DEFAULT_RECALL_CONFIG } from '../../src/recall';
import type { RecallDeps } from '../../src/recall';
import type { FactRecord, FactMirror } from '../../src/ports';
import { FakeVectorIndex, FakeKeywordIndex, FakeEmbedding, FakeChunkStats, fixedClock } from './fakes';

function frec(over: Partial<FactRecord> & { id: string; entity: string }): FactRecord {
  return {
    profileId: 'default', type: 'medication', version: 1, status: 'active',
    fields: {}, safetyRelevant: false, authority: 'user', confidence: 0.9,
    createdAt: '2026-08-01T00:00:00.000Z', ...over,
  };
}

/** A FactMirror whose `queryActive()` throws — reproducing an unavailable SQLite mirror
 *  (corrupted file, mid-rebuild, etc.). `queryPaused`/`queryEntityHeads` stay empty-but-working
 *  so the test isolates Stage-1's active-facts fallback specifically. */
class ThrowingActiveFactMirror implements FactMirror {
  async upsert(): Promise<void> { /* unused */ }
  async replaceType(): Promise<void> { /* unused */ }
  async replaceScope(): Promise<void> { /* unused */ }
  // eslint-disable-next-line @typescript-eslint/require-await, require-yield
  async *queryActive(): AsyncIterable<FactRecord> {
    throw new Error('SQLITE_CORRUPT: fact mirror unavailable');
  }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-empty-function
  async *queryPaused(): AsyncIterable<FactRecord> { /* empty */ }
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-empty-function
  async *queryEntityHeads(): AsyncIterable<FactRecord> { /* empty */ }
  async rebuild(): Promise<void> { /* unused */ }
}

function makeEngine(over: Partial<RecallDeps> = {}): RecallEngine {
  return new RecallEngine({
    embedding: over.embedding ?? new FakeEmbedding(),
    vectorIndex: over.vectorIndex ?? new FakeVectorIndex(),
    keywordIndex: over.keywordIndex ?? new FakeKeywordIndex(),
    factMirror: over.factMirror ?? new ThrowingActiveFactMirror(),
    chunkStats: over.chunkStats ?? new FakeChunkStats(),
    clock: over.clock ?? fixedClock('2026-10-01T00:00:00.000Z'),
    config: over.config ?? DEFAULT_RECALL_CONFIG,
    fallbackActiveFacts: over.fallbackActiveFacts,
  });
}

// RED item #4 / mini-plan v3 §3.7 Finding-3: on HEAD a678272, `stage1Ledger`'s catch block
// unconditionally returns an empty ledger context when `factMirror.queryActive()` throws — a
// fail-OPEN clinical hazard (a discontinued/active medication silently vanishes from the prompt).
describe('RR-STRUCT R-S3 — stage1Ledger fallbackActiveFacts (Finding-3, clinical-hazard fix)', () => {
  it('RED baseline: without a fallback port, a mirror failure degrades to an EMPTY ledger context (pre-R-S3 behavior, unchanged)', async () => {
    const r = await makeEngine().run({ profileId: 'default', userMessage: 'hello' });
    expect(r.ledger).toBe('');
  });

  it('FIXED: with the fallback port wired, a mirror failure falls back to the ledger-backed read — NEVER empty', async () => {
    const activeFromLedger: FactRecord[] = [
      frec({ id: 'metformin@v1', entity: 'metformin', type: 'medication', fields: { dose: '500mg' } }),
      frec({ id: 'penicillin@v1', entity: 'penicillin', type: 'allergy', safetyRelevant: true }),
    ];
    const r = await makeEngine({
      fallbackActiveFacts: async () => activeFromLedger,
    }).run({ profileId: 'default', userMessage: 'hello' });
    expect(r.ledger).toContain('metformin');
    expect(r.ledger).toContain('penicillin');
  });

  it('the fallback is NOT consulted when the mirror is healthy (no behavior change on the happy path)', async () => {
    let fallbackCalls = 0;
    const engine = makeEngine({
      factMirror: {
        async upsert(): Promise<void> {},
        async replaceType(): Promise<void> {},
        async replaceScope(): Promise<void> {},
        // eslint-disable-next-line @typescript-eslint/require-await
        async *queryActive(): AsyncIterable<FactRecord> {
          yield frec({ id: 'aspirin@v1', entity: 'aspirin', type: 'medication' });
        },
        // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-empty-function
        async *queryPaused(): AsyncIterable<FactRecord> {},
        // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-empty-function
        async *queryEntityHeads(): AsyncIterable<FactRecord> {},
        async rebuild(): Promise<void> {},
      },
      fallbackActiveFacts: async () => { fallbackCalls += 1; return []; },
    });
    const r = await engine.run({ profileId: 'default', userMessage: 'hello' });
    expect(r.ledger).toContain('aspirin');
    expect(fallbackCalls).toBe(0);
  });
});
