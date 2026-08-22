import { RecallEngine, DEFAULT_RECALL_CONFIG } from '../../src/recall';
import type { RecallDeps } from '../../src/recall';
import type { FactRecord, FactMirror } from '../../src/ports';
import {
  FakeFactMirror, FakeVectorIndex, FakeKeywordIndex, FakeEmbedding, FakeChunkStats, fixedClock, chunkHit,
} from './fakes';

function frec(over: Partial<FactRecord> & { id: string; entity: string }): FactRecord {
  return {
    profileId: 'default', type: 'medication', version: 1, status: 'active',
    fields: {}, safetyRelevant: false, authority: 'user', confidence: 0.9,
    createdAt: '2026-08-01T00:00:00.000Z', ...over,
  };
}

function makeEngine(over: Partial<RecallDeps> = {}): RecallEngine {
  return new RecallEngine({
    embedding: over.embedding ?? new FakeEmbedding(),
    vectorIndex: over.vectorIndex ?? new FakeVectorIndex(),
    keywordIndex: over.keywordIndex ?? new FakeKeywordIndex(),
    factMirror: over.factMirror ?? new FakeFactMirror(),
    chunkStats: over.chunkStats ?? new FakeChunkStats(),
    clock: over.clock ?? fixedClock('2026-10-01T00:00:00.000Z'),
    config: over.config ?? DEFAULT_RECALL_CONFIG,
  });
}

describe('RecallEngine — Stage 1 (active ledger)', () => {
  it('injects active clinical facts, excludes discontinued, includes paused with pre_pause_summary (KNEE-08)', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'metformin@v1', entity: 'metformin', type: 'medication', status: 'active', fields: { dose: '500mg' } }),
      frec({ id: 'naproxen@v1', entity: 'naproxen', type: 'medication', status: 'discontinued' }),
      frec({ id: 'gym@v2', entity: 'gym-goal', type: 'goal', status: 'paused', fields: { pre_pause_summary: '2x/week moderate strength' } }),
    ]);
    const r = await makeEngine({ factMirror: mirror }).run({ profileId: 'default', userMessage: 'hello' });
    expect(r.ledger).toContain('metformin');
    expect(r.ledger).toContain('gym-goal');
    expect(r.ledger).toContain('2x/week moderate strength');
    expect(r.ledger).not.toContain('naproxen');
  });

  it('CONTRA-07: dedupes by entity, keeping only the highest active version', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'metformin@v3', entity: 'metformin', version: 3, status: 'active', fields: { dose: '850mg' } }),
      frec({ id: 'metformin@v5', entity: 'metformin', version: 5, status: 'active', fields: { dose: '1000mg' } }),
    ]);
    const r = await makeEngine({ factMirror: mirror }).run({ profileId: 'default', userMessage: 'hello' });
    expect(r.ledger).toContain('1000mg');
    expect(r.ledger).not.toContain('850mg');
  });

  it('caps the ledger section at the configured token budget', async () => {
    const many: FactRecord[] = [];
    for (let i = 0; i < 60; i++) {
      many.push(frec({ id: `m${i}`, entity: `entity-number-${i}`, fields: { note: 'some reasonably long clinical detail here' } }));
    }
    const r = await makeEngine({
      factMirror: new FakeFactMirror(many),
      config: { ...DEFAULT_RECALL_CONFIG, ledgerBudget: 50 },
    }).run({ profileId: 'default', userMessage: 'hello' });
    expect(r.ledgerTokens).toBeLessThanOrEqual(50);
    // 60 long facts cannot all fit in 50 tokens
    expect(r.ledger).not.toContain('entity-number-59');
  });
});

describe('RecallEngine — Stage 2 (hybrid narrative recall)', () => {
  it('merges vec+keyword by id, thresholds on raw, drops below-threshold chunks', async () => {
    const strong = chunkHit({ id: 'c-strong', content: 'walking helped my mood a lot lately', createdAt: '2026-10-01T00:00:00.000Z', score: 0.8 });
    const weak = chunkHit({ id: 'c-weak', content: 'a mostly unrelated aside about nothing', createdAt: '2026-10-01T00:00:00.000Z', score: 0.2 });
    const r = await makeEngine({
      vectorIndex: new FakeVectorIndex([strong, weak]),
      keywordIndex: new FakeKeywordIndex([{ ...strong, score: 0.4 }]),
    }).run({ profileId: 'default', userMessage: 'how is my mood' });
    expect(r.narrative).toContain('walking helped my mood');
    expect(r.narrative).not.toContain('unrelated aside');
    expect(r.injectedChunkIds).toContain('c-strong');
    expect(r.indexStatus).toBe('full');
  });

  it('CONTRA-10: suppresses chunks whose ledger entity has a newer active version', async () => {
    // Dates kept recent so the surviving v3 chunk is not separately decayed away — this isolates
    // the suppression mechanism (older versions dropped because the entity head is newer).
    const mirror = new FakeFactMirror([
      frec({ id: 'metformin@v1', entity: 'metformin', version: 1, status: 'retracted', createdAt: '2026-09-28T00:00:00.000Z' }),
      frec({ id: 'metformin@v2', entity: 'metformin', version: 2, status: 'superseded', createdAt: '2026-09-29T00:00:00.000Z' }),
      frec({ id: 'metformin@v3', entity: 'metformin', version: 3, status: 'active', createdAt: '2026-09-30T00:00:00.000Z' }),
    ]);
    const chunks = [
      chunkHit({ id: 'ck1', content: 'metformin 500mg noted', lane: 'narrative', createdAt: '2026-09-28T00:00:00.000Z', score: 0.9 }),
      chunkHit({ id: 'ck2', content: 'metformin 850mg noted', lane: 'narrative', createdAt: '2026-09-29T00:00:00.000Z', score: 0.9 }),
      chunkHit({ id: 'ck3', content: 'metformin 1000mg noted', lane: 'narrative', createdAt: '2026-09-30T00:00:00.000Z', score: 0.9 }),
    ];
    const r = await makeEngine({ factMirror: mirror, vectorIndex: new FakeVectorIndex(chunks) })
      .run({ profileId: 'default', userMessage: 'what metformin dose' });
    expect(r.narrative).toContain('1000mg');
    expect(r.narrative).not.toContain('500mg');
    expect(r.narrative).not.toContain('850mg');
  });

  it('KNEE-10: suppresses chunks for a discontinued entity (stale fail-closed)', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'naproxen@v2', entity: 'naproxen', version: 2, status: 'discontinued', createdAt: '2026-08-15T00:00:00.000Z' }),
    ]);
    const chunk = chunkHit({ id: 'nap', content: 'naproxen can cause nausea', lane: 'narrative', createdAt: '2026-07-01T00:00:00.000Z', score: 0.9 });
    const r = await makeEngine({ factMirror: mirror, vectorIndex: new FakeVectorIndex([chunk]) })
      .run({ profileId: 'default', userMessage: 'why am I nauseous' });
    expect(r.narrative).not.toContain('naproxen');
    expect(r.injectedChunkIds).toHaveLength(0);
  });

  it('KNEE-06: a dormant safety_relevant fact clears the 0.3 threshold despite age (decay=1)', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'knee@v2', entity: 'knee-injury', type: 'condition', version: 2, status: 'resolved', safetyRelevant: true, authority: 'report', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    // A knee chunk ~90 days old. Non-safety it would decay to exp(-90/120)=0.47 → raw ~0.32 < 0.5 (dropped);
    // safety_relevant → decay=1 → raw 0.68 ≥ 0.3 (kept). lane 'ledger' → safety threshold applies.
    const knee = chunkHit({ id: 'knee-ck', content: 'knee injury MCL sprain avoid heavy leg loading', lane: 'ledger', createdAt: '2026-07-01T00:00:00.000Z', score: 0.8 });
    const r = await makeEngine({
      factMirror: mirror,
      vectorIndex: new FakeVectorIndex([knee]),
      keywordIndex: new FakeKeywordIndex([{ ...knee, score: 0.4 }]),
    }).run({ profileId: 'default', userMessage: 'plan me a workout' });
    expect(r.narrative).toContain('avoid heavy leg loading');
    const hit = r.hits.find(h => h.id === 'knee-ck');
    expect(hit?.safetyRelevant).toBe(true);
  });

  it('VANI-10 (recall half): finds a dormant chest-pain episode on "chest tightness"', async () => {
    // "chest tightness" ↔ "chest pain" carries both semantic + keyword overlap; a ~30-day-old
    // non-safety episode needs that combined signal to clear 0.5 after decay.
    const episode = chunkHit({ id: 'ep-chest', content: 'chest pain episode — diagnosed as anxiety attack', lane: 'episode', createdAt: '2026-09-01T00:00:00.000Z', score: 0.85 });
    const r = await makeEngine({
      vectorIndex: new FakeVectorIndex([episode]),
      keywordIndex: new FakeKeywordIndex([{ ...episode, score: 0.5 }]),
      clock: fixedClock('2026-10-01T00:00:00.000Z'),
    }).run({ profileId: 'default', userMessage: 'my chest still feels tight sometimes' });
    expect(r.narrative).toContain('anxiety attack');
  });

  it('CHAT-08: returns at most finalTopK results within the narrative token budget', async () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      chunkHit({ id: `big${i}`, content: `health note number ${i} with enough words to matter here`, createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 }));
    const r = await makeEngine({ vectorIndex: new FakeVectorIndex(chunks), config: { ...DEFAULT_RECALL_CONFIG, narrativeBudget: 60 } })
      .run({ profileId: 'default', userMessage: 'health' });
    expect(r.injectedChunkIds.length).toBeLessThanOrEqual(DEFAULT_RECALL_CONFIG.finalTopK);
    expect(r.narrativeTokens).toBeLessThanOrEqual(60);
  });

  it('dedupes chunks with identical content, keeping the best-scoring one', async () => {
    const a = chunkHit({ id: 'dup-a', content: 'i went for a long calming walk today', createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 });
    const b = chunkHit({ id: 'dup-b', content: 'i went for a long calming walk today', createdAt: '2026-10-01T00:00:00.000Z', score: 0.6 });
    const r = await makeEngine({ vectorIndex: new FakeVectorIndex([a, b]) })
      .run({ profileId: 'default', userMessage: 'did I walk' });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].id).toBe('dup-a'); // higher raw retained
  });

  it('CHAT-07: health-lane content is biased above non-health rants of similar relevance', async () => {
    const health = Array.from({ length: 4 }, (_, i) =>
      chunkHit({ id: `h${i}`, content: `stress and chest tightness note ${i}`, lane: 'episode', createdAt: '2026-10-01T00:00:00.000Z', score: 0.75 }));
    const rants = Array.from({ length: 3 }, (_, i) =>
      chunkHit({ id: `r${i}`, content: `inception made my head hurt rant ${i}`, lane: 'narrative', createdAt: '2026-10-01T00:00:00.000Z', score: 0.78 }));
    const r = await makeEngine({
      vectorIndex: new FakeVectorIndex([...health, ...rants]),
      config: { ...DEFAULT_RECALL_CONFIG, finalTopK: 5 },
    }).run({ profileId: 'default', userMessage: 'is my stress affecting my heart' });
    const healthCount = r.hits.filter(h => h.lane === 'episode').length;
    expect(r.hits.length).toBe(5);
    expect(healthCount).toBeGreaterThanOrEqual(4);
  });
});

describe('RecallEngine — Stage 3 (deterministic side-effect correlation)', () => {
  it('DIAB-05: a new symptom matching an active med side effect emits a CHECK line with the temporal window', async () => {
    const mirror = new FakeFactMirror([
      frec({
        id: 'jardiance@v1', entity: 'jardiance', type: 'medication', status: 'active', safetyRelevant: true,
        fields: { started: '2026-10-01', known_side_effects: ['genital-yeast-infection', 'uti', 'dehydration', 'hypoglycemia'] },
      }),
    ]);
    const r = await makeEngine({ factMirror: mirror, clock: fixedClock('2026-11-15T00:00:00.000Z') })
      .run({ profileId: 'default', userMessage: "I'm getting yeast infections. Noticed it a couple weeks ago." });
    expect(r.entity).toContain('jardiance');
    expect(r.entity.toLowerCase()).toContain('yeast');
    expect(r.entity.toLowerCase()).toContain('side effect');
    expect(r.entity).toContain('6 week'); // started 2026-10-01 → ~6 weeks before 2026-11-15
    expect(r.entity).toContain('No diagnostic certainty'); // a check, never an alarm
  });

  it('does not fire when the symptom matches no side effect', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'jardiance@v1', entity: 'jardiance', type: 'medication', status: 'active', fields: { started: '2026-10-01', known_side_effects: ['uti', 'dehydration'] } }),
    ]);
    const r = await makeEngine({ factMirror: mirror, clock: fixedClock('2026-11-15T00:00:00.000Z') })
      .run({ profileId: 'default', userMessage: 'I have a mild headache today' });
    expect(r.entity).toBe('');
  });

  it('only correlates against ACTIVE meds (a discontinued med does not fire)', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'jardiance@v2', entity: 'jardiance', version: 2, type: 'medication', status: 'discontinued', fields: { started: '2026-10-01', known_side_effects: ['genital-yeast-infection'] } }),
    ]);
    const r = await makeEngine({ factMirror: mirror, clock: fixedClock('2026-11-15T00:00:00.000Z') })
      .run({ profileId: 'default', userMessage: 'yeast infections again' });
    expect(r.entity).toBe('');
  });
});

describe('RecallEngine — Stage 4 (feedback + auto-mute)', () => {
  it('bumps injected_count for every injected chunk on run', async () => {
    const stats = new FakeChunkStats();
    const chunks = [
      chunkHit({ id: 'a', content: 'a health note that scores fine', createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 }),
      chunkHit({ id: 'b', content: 'another health note that scores fine', createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 }),
    ];
    const r = await makeEngine({ vectorIndex: new FakeVectorIndex(chunks), chunkStats: stats })
      .run({ profileId: 'default', userMessage: 'health' });
    expect(stats.injected.sort()).toEqual([...r.injectedChunkIds].sort());
    expect(stats.injected).toContain('a');
  });

  it('recordUsage bumps used_count via the stats writer', async () => {
    const stats = new FakeChunkStats();
    await makeEngine({ chunkStats: stats }).recordUsage(['a', 'b'], '2026-10-01T00:00:00.000Z');
    expect(stats.used).toEqual([{ ids: ['a', 'b'], at: '2026-10-01T00:00:00.000Z' }]);
    expect((await stats.get('a'))?.usedCount).toBe(1);
  });

  it('B4: auto-mutes a non-exempt chunk injected ≥20 with 0 uses', async () => {
    const stats = new FakeChunkStats();
    stats.seed('rant', 20, 0);
    const chunk = chunkHit({ id: 'rant', content: 'the same movie rant injected many times', lane: 'narrative', createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 });
    const r = await makeEngine({ vectorIndex: new FakeVectorIndex([chunk]), chunkStats: stats })
      .run({ profileId: 'default', userMessage: 'movie' });
    expect(r.injectedChunkIds).not.toContain('rant');
  });

  it('B4: never auto-mutes a safety_relevant chunk even at 20 injected / 0 used', async () => {
    const stats = new FakeChunkStats();
    stats.seed('knee-ck', 20, 0);
    const mirror = new FakeFactMirror([
      frec({ id: 'knee@v1', entity: 'knee-injury', type: 'condition', status: 'resolved', safetyRelevant: true, createdAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    const chunk = chunkHit({ id: 'knee-ck', content: 'knee injury avoid heavy leg loading', lane: 'ledger', createdAt: '2026-09-01T00:00:00.000Z', score: 0.9 });
    const r = await makeEngine({
      vectorIndex: new FakeVectorIndex([chunk]),
      keywordIndex: new FakeKeywordIndex([{ ...chunk, score: 0.4 }]),
      factMirror: mirror, chunkStats: stats,
    }).run({ profileId: 'default', userMessage: 'plan a workout' });
    expect(r.injectedChunkIds).toContain('knee-ck');
  });

  it('B4: never auto-mutes a ledger|episode-lane chunk even at 20 injected / 0 used', async () => {
    const stats = new FakeChunkStats();
    stats.seed('ep', 20, 0);
    const chunk = chunkHit({ id: 'ep', content: 'a recurring episode note about sleep', lane: 'episode', createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 });
    const r = await makeEngine({ vectorIndex: new FakeVectorIndex([chunk]), chunkStats: stats })
      .run({ profileId: 'default', userMessage: 'sleep' });
    expect(r.injectedChunkIds).toContain('ep');
  });
});

describe('RecallEngine — resilience (never crashes the turn)', () => {
  it('a throwing factMirror degrades each stage rather than crashing', async () => {
    // An async-iterable that rejects on iteration (avoids a yield-less generator, require-yield).
    const boom = (): AsyncIterable<FactRecord> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('boom')) }),
    });
    const throwingMirror: FactMirror = {
      upsert: async () => {}, rebuild: async () => {},
      queryActive: boom, queryPaused: boom, queryEntityHeads: boom,
    };
    const chunk = chunkHit({ id: 'c', content: 'a note that scores well enough here', createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 });
    const r = await makeEngine({ factMirror: throwingMirror, vectorIndex: new FakeVectorIndex([chunk]) })
      .run({ profileId: 'default', userMessage: 'note' });
    expect(r.ledger).toBe('');  // stage 1 degraded
    expect(r.entity).toBe('');  // stage 3 degraded
    // stage 2 heads-load caught → no suppression → the chunk still surfaces (best-effort)
    expect(r.narrative).toContain('a note that scores well enough');
  });
});

describe('RecallEngine — Stage 2 degrade (PLAT-11 keyword-only)', () => {
  const kw = () => chunkHit({ id: 'kw1', content: 'sleep has been rough lately per keyword search', createdAt: '2026-10-01T00:00:00.000Z', score: 0.8 });

  it('embed throw → keyword-only status, keyword hits still returned', async () => {
    const r = await makeEngine({
      embedding: new FakeEmbedding({ throwErr: true }),
      vectorIndex: new FakeVectorIndex([chunkHit({ id: 'vec-only', content: 'vector arm only note', createdAt: '2026-10-01T00:00:00.000Z', score: 0.95 })]),
      keywordIndex: new FakeKeywordIndex([kw()]),
    }).run({ profileId: 'default', userMessage: 'sleep' });
    expect(r.indexStatus).toBe('keyword-only');
    expect(r.narrative).toContain('sleep has been rough');
    expect(r.narrative).not.toContain('vector arm only note'); // vec arm skipped on degrade
  });

  it('embed timeout (>embedTimeoutMs) → keyword-only status, keyword hits still returned', async () => {
    const r = await makeEngine({
      embedding: new FakeEmbedding({ delayMs: 60 }),
      keywordIndex: new FakeKeywordIndex([kw()]),
      config: { ...DEFAULT_RECALL_CONFIG, embedTimeoutMs: 5 },
    }).run({ profileId: 'default', userMessage: 'sleep' });
    expect(r.indexStatus).toBe('keyword-only');
    expect(r.narrative).toContain('sleep has been rough');
  });
});
