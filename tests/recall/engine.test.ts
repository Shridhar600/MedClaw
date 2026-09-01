import { RecallEngine, DEFAULT_RECALL_CONFIG } from '../../src/recall';
import type { RecallDeps } from '../../src/recall';
import type { FactRecord, FactMirror } from '../../src/ports';
import {
  FakeFactMirror, FakeVectorIndex, FakeKeywordIndex, FakeEmbedding, FakeChunkStats, ThrowingChunkStats, fixedClock, chunkHit,
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

  it('renders every dual-active value as an explicit conflict instead of choosing one', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'metformin@v3', entity: 'metformin', version: 3, status: 'active', fields: { dose: '850mg' } }),
      frec({ id: 'metformin@v5', entity: 'metformin', version: 5, status: 'active', fields: { dose: '1000mg' } }),
    ]);
    const r = await makeEngine({ factMirror: mirror }).run({ profileId: 'default', userMessage: 'hello' });
    expect(r.ledger).toContain('CONFLICT');
    expect(r.ledger).toContain('1000mg');
    expect(r.ledger).toContain('850mg');
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
    // Version statements live in the ledger file → lane 'ledger'; newer-active suppression is scoped
    // to ledger-lane chunks (see the F2 fix-pass test — narrative mentions are NOT version-suppressed).
    const chunks = [
      chunkHit({ id: 'ck1', content: 'metformin 500mg noted', lane: 'ledger', createdAt: '2026-09-28T00:00:00.000Z', score: 0.9 }),
      chunkHit({ id: 'ck2', content: 'metformin 850mg noted', lane: 'ledger', createdAt: '2026-09-29T00:00:00.000Z', score: 0.9 }),
      chunkHit({ id: 'ck3', content: 'metformin 1000mg noted', lane: 'ledger', createdAt: '2026-09-30T00:00:00.000Z', score: 0.9 }),
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
    expect(r.checkNotes).toContain('jardiance');
    expect(r.checkNotes.toLowerCase()).toContain('yeast');
    expect(r.checkNotes.toLowerCase()).toContain('side effect');
    expect(r.checkNotes).toContain('6 week'); // started 2026-10-01 → ~6 weeks before 2026-11-15
    expect(r.checkNotes).toContain('No diagnostic certainty'); // a check, never an alarm
  });

  it('does not fire when the symptom matches no side effect', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'jardiance@v1', entity: 'jardiance', type: 'medication', status: 'active', fields: { started: '2026-10-01', known_side_effects: ['uti', 'dehydration'] } }),
    ]);
    const r = await makeEngine({ factMirror: mirror, clock: fixedClock('2026-11-15T00:00:00.000Z') })
      .run({ profileId: 'default', userMessage: 'I have a mild headache today' });
    expect(r.checkNotes).toBe('');
  });

  it('only correlates against ACTIVE meds (a discontinued med does not fire)', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'jardiance@v2', entity: 'jardiance', version: 2, type: 'medication', status: 'discontinued', fields: { started: '2026-10-01', known_side_effects: ['genital-yeast-infection'] } }),
    ]);
    const r = await makeEngine({ factMirror: mirror, clock: fixedClock('2026-11-15T00:00:00.000Z') })
      .run({ profileId: 'default', userMessage: 'yeast infections again' });
    expect(r.checkNotes).toBe('');
  });
});

describe('RecallEngine — Wave C fix-pass (M-1: mode-gated narrative)', () => {
  it('narrative:false skips embed + bumpInjected but still returns the Stage-1 ledger', async () => {
    const embedding = new FakeEmbedding();
    const embedSpy = jest.spyOn(embedding, 'embed');
    const chunkStats = new FakeChunkStats();
    const mirror = new FakeFactMirror([
      frec({ id: 'metformin@v1', entity: 'metformin', status: 'active', fields: { dose: '500mg' } }),
    ]);
    const vectorIndex = new FakeVectorIndex([
      chunkHit({ id: 'h1', score: 0.95, lane: 'ledger', content: 'metformin note that would score' }),
    ]);

    const r = await makeEngine({ embedding, chunkStats, factMirror: mirror, vectorIndex })
      .run({ profileId: 'default', userMessage: 'metformin' }, { narrative: false });

    expect(embedSpy).not.toHaveBeenCalled();
    expect(chunkStats.injected).toEqual([]);
    expect(r.hits).toEqual([]);
    expect(r.narrative).toBe('');
    expect(r.ledger).toContain('metformin');
  });

  it('narrative defaults to true (heartbeat opt-out only): a normal run still bumps injected', async () => {
    const chunkStats = new FakeChunkStats();
    const vectorIndex = new FakeVectorIndex([
      chunkHit({ id: 'h1', score: 0.95, lane: 'ledger', content: 'a health note that scores fine', createdAt: '2026-10-01T00:00:00.000Z' }),
    ]);
    const r = await makeEngine({ chunkStats, vectorIndex }).run({ profileId: 'default', userMessage: 'health' });
    expect(r.injectedChunkIds.length).toBeGreaterThan(0);
    expect(chunkStats.injected.length).toBeGreaterThan(0);
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
    expect(r.checkNotes).toBe('');  // stage 3 degraded
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

describe('RecallEngine — Wave B fix-pass (panel findings)', () => {
  // F1: the pre-decay floor must not drop safety_relevant chunks (B6 "OR safety_relevant" carve-out).
  // With the floor configured ABOVE both chunks' base, only the safety chunk (exempt) survives.
  it('F1: a safety_relevant chunk is exempt from the pre-decay floor; a non-safety peer is not', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'knee@v1', entity: 'knee-injury', type: 'condition', status: 'resolved', safetyRelevant: true, createdAt: '2026-09-15T00:00:00.000Z' }),
    ]);
    // base = 0.7*0.5 + 0.3*0.4 = 0.47, below the configured floor 0.5, above the 0.3 safety threshold.
    const safety = chunkHit({ id: 'safe', content: 'knee injury precaution avoid heavy loading', lane: 'ledger', createdAt: '2026-09-15T00:00:00.000Z', score: 0.5 });
    const plain = chunkHit({ id: 'plain', content: 'an unrelated jotting about the weather today', lane: 'ledger', createdAt: '2026-09-15T00:00:00.000Z', score: 0.5 });
    const r = await makeEngine({
      factMirror: mirror,
      vectorIndex: new FakeVectorIndex([safety, plain]),
      keywordIndex: new FakeKeywordIndex([{ ...safety, score: 0.4 }, { ...plain, score: 0.4 }]),
      config: { ...DEFAULT_RECALL_CONFIG, preDecayFloor: 0.5 },
    }).run({ profileId: 'default', userMessage: 'plan a workout' });
    expect(r.narrative).toContain('avoid heavy loading'); // safety chunk exempt from floor, passes 0.3
    expect(r.hits.map(h => h.id)).not.toContain('plain'); // non-safety floored out at 0.47 < 0.5
  });

  // F2: newer-active suppression is scoped to ledger-lane version statements; a narrative adverse-event
  // mention of an active med is NOT suppressed by a later routine dose update.
  it('F2: an adverse-event narrative for an active med survives a newer active head', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'met@v2', entity: 'metformin', version: 2, status: 'active', safetyRelevant: true, createdAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    const adverse = chunkHit({ id: 'adv', content: 'felt shaky and sweaty after taking metformin', lane: 'narrative', createdAt: '2026-06-01T00:00:00.000Z', score: 0.85 });
    const r = await makeEngine({ factMirror: mirror, vectorIndex: new FakeVectorIndex([adverse]) })
      .run({ profileId: 'default', userMessage: 'why do I feel shaky' });
    expect(r.narrative).toContain('felt shaky and sweaty');
  });

  // F2b: a ledger-lane older version IS still suppressed (CONTRA-10 preserved).
  it('F2b: a ledger-lane chunk older than the active head is still suppressed', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'met@v2', entity: 'metformin', version: 2, status: 'active', createdAt: '2026-09-30T00:00:00.000Z' }),
    ]);
    const old = chunkHit({ id: 'oldver', content: 'metformin 500mg noted', lane: 'ledger', createdAt: '2026-06-01T00:00:00.000Z', score: 0.9 });
    const r = await makeEngine({ factMirror: mirror, vectorIndex: new FakeVectorIndex([old]) })
      .run({ profileId: 'default', userMessage: 'metformin dose' });
    expect(r.narrative).not.toContain('500mg');
  });

  // F4: suppression tolerates plural/inflected mentions (KNEE-10 must not leak on "UTIs").
  it('F4: a plural mention of a discontinued entity is still suppressed', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'uti@v2', entity: 'uti', type: 'condition', version: 2, status: 'discontinued', createdAt: '2026-08-01T00:00:00.000Z' }),
    ]);
    const chunk = chunkHit({ id: 'utick', content: 'recurrent UTIs kept coming back last year', lane: 'narrative', createdAt: '2026-07-01T00:00:00.000Z', score: 0.9 });
    const r = await makeEngine({ factMirror: mirror, vectorIndex: new FakeVectorIndex([chunk]) })
      .run({ profileId: 'default', userMessage: 'urinary problems' });
    expect(r.injectedChunkIds).not.toContain('utick');
  });

  // F8: a throwing chunkStats.get must not sink the whole turn (per-dependency resilience).
  it('F8: a throwing chunkStats read degrades to no-mute, recall still surfaces', async () => {
    const chunk = chunkHit({ id: 'ck', content: 'a decent health note about energy levels', lane: 'narrative', createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 });
    const r = await makeEngine({ vectorIndex: new FakeVectorIndex([chunk]), chunkStats: new ThrowingChunkStats() })
      .run({ profileId: 'default', userMessage: 'energy' });
    expect(r.narrative).toContain('a decent health note');
    expect(r.indexStatus).not.toBe('failed');
  });

  // F8b: a keyword-arm throw must not discard already-gathered vec candidates; status stays 'full'.
  it('F8b: a keyword-index throw preserves vec candidates (status full)', async () => {
    const vecHit = chunkHit({ id: 'v', content: 'a solid vector-found health note here', createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 });
    const r = await makeEngine({
      vectorIndex: new FakeVectorIndex([vecHit]),
      keywordIndex: new FakeKeywordIndex([], true), // throws on match
    }).run({ profileId: 'default', userMessage: 'health' });
    expect(r.narrative).toContain('vector-found health note');
    expect(r.indexStatus).toBe('full');
  });

  // F6: an empty embedding vector is an outage → keyword-only + status, not a silent 'full'.
  it('F6: an empty embedding vector degrades to keyword-only', async () => {
    const kw = chunkHit({ id: 'kw', content: 'keyword note about sleep quality lately', createdAt: '2026-10-01T00:00:00.000Z', score: 0.8 });
    const r = await makeEngine({
      embedding: new FakeEmbedding({ vector: [] }),
      vectorIndex: new FakeVectorIndex([chunkHit({ id: 'vhit', content: 'vector note', createdAt: '2026-10-01T00:00:00.000Z', score: 0.9 })]),
      keywordIndex: new FakeKeywordIndex([kw]),
    }).run({ profileId: 'default', userMessage: 'sleep' });
    expect(r.indexStatus).toBe('keyword-only');
    expect(r.narrative).not.toContain('vector note');
  });

  // F3: Stage-1 budget must prioritize safety rows (allergy) so they are never silently evicted.
  it('F3: an allergy (safety) row survives the ledger budget even when placed last, and truncation is flagged', async () => {
    const facts: FactRecord[] = [];
    for (let i = 0; i < 40; i++) {
      facts.push(frec({ id: `g${i}`, entity: `goal-number-${i}`, type: 'goal', fields: { note: 'a reasonably long non-safety goal detail line' } }));
    }
    facts.push(frec({ id: 'pen', entity: 'penicillin', type: 'allergy', status: 'active', safetyRelevant: true, fields: { reaction: 'hives' } }));
    const r = await makeEngine({
      factMirror: new FakeFactMirror(facts),
      config: { ...DEFAULT_RECALL_CONFIG, ledgerBudget: 40 },
    }).run({ profileId: 'default', userMessage: 'hello' });
    expect(r.ledger).toContain('penicillin');
    expect(r.ledgerTruncated).toBe(true);
  });

  // F7: Stage-3 correlates only recent(90d) meds; a long-standing med does not fire on every mention.
  it('F7: a med started >90d ago does not emit a side-effect CHECK', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'jard@v1', entity: 'jardiance', type: 'medication', status: 'active', fields: { started: '2024-01-01', known_side_effects: ['genital-yeast-infection'] } }),
    ]);
    const r = await makeEngine({ factMirror: mirror, clock: fixedClock('2026-11-15T00:00:00.000Z') })
      .run({ profileId: 'default', userMessage: 'getting yeast infections' });
    expect(r.checkNotes).toBe('');
  });

  // F15: an entity with both an active head and an older paused version renders once (active wins).
  it('F15: an entity active head is not double-rendered with its older paused version', async () => {
    const mirror = new FakeFactMirror([
      frec({ id: 'gym@v3', entity: 'gym-goal', type: 'goal', version: 3, status: 'active', fields: { target: '3x/week' } }),
      frec({ id: 'gym@v2', entity: 'gym-goal', type: 'goal', version: 2, status: 'paused', fields: { pre_pause_summary: '2x/week moderate' } }),
    ]);
    const r = await makeEngine({ factMirror: mirror }).run({ profileId: 'default', userMessage: 'hello' });
    expect(r.ledger.match(/gym-goal/g)?.length).toBe(1);
    expect(r.ledger).toContain('active');
  });
});
