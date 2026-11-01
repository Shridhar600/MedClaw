import * as fs from 'fs';
import * as path from 'path';
import { LedgerStore, SafetyView, TYPE_TO_FILE } from '../../src/memcore';
import type { FactType, Provenance } from '../../src/memcore/types';
import { RecallEngine, DEFAULT_RECALL_CONFIG } from '../../src/recall';
import { ContextAssembler } from '../../src/context2';
import { MemoryEngine } from '../../src/memory/memory-engine';
import { SqliteVecIndex, SqliteKeywordIndex, SqliteFactMirror, SqliteChunkStats, ledgerFactToRecord } from '../../src/indexstore';
import type { Chunk, Clock, EmbeddingPort } from '../../src/ports';
import { makeTestTemp } from '../helpers/test-temp';

const NOW = '2026-08-24T00:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(new Date(NOW).getTime() - n * DAY).toISOString();
const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

const CONCEPTS = ['knee', 'glucose', 'sleep', 'skin', 'generic'] as const;
const CONCEPT_KW: Record<string, string[]> = {
  knee: ['knee', 'workout', 'exercise', 'run', 'running', 'gym', 'squat', 'leg', 'joint', 'naproxen', 'ibuprofen', 'mcl'],
  glucose: ['glucose', 'sugar', 'diabetes', 'metformin', 'insulin', 'a1c'],
  sleep: ['sleep', 'insomnia', 'tired', 'melatonin'],
  skin: ['skin', 'rash', 'itch', 'eczema'],
  generic: [],
};
function conceptVector(text: string): number[] {
  const t = text.toLowerCase();
  const v: number[] = CONCEPTS.map(c => (CONCEPT_KW[c].some(w => t.includes(w)) ? 1 : 0));
  if (!v.some(x => x > 0)) v[CONCEPTS.indexOf('generic')] = 1; // never a zero vector (cosine sanity)
  return v;
}
class ConceptEmbedding implements EmbeddingPort {
  constructor(private opts: { throwErr?: boolean } = {}) {}
  async embed(texts: string[]): Promise<number[][]> {
    if (this.opts.throwErr) throw new Error('embed failed');
    return texts.map(conceptVector);
  }
  async dim(): Promise<number> { return CONCEPTS.length; }
  async modelId(): Promise<string> { return 'concept-embed'; }
}

const prov = (source: Provenance['source'], capturedAt = NOW): Provenance =>
  ({ source, confidence: 0.95, anchor: 'memory/visit.md#L1', capturedAt, note: '' });

describe('recall acceptance (real adapters, disk-backed → assembled prompt)', () => {
  let tmp: string;
  let dbPath: string;
  let ledger: LedgerStore;
  let safety: SafetyView;
  let mirror: SqliteFactMirror;
  let vec: SqliteVecIndex;
  let keyword: SqliteKeywordIndex;
  let stats: SqliteChunkStats;
  let assembler: ContextAssembler;
  let clock: Clock;

  const build = (embed: EmbeddingPort = new ConceptEmbedding()): RecallEngine => new RecallEngine({
    embedding: embed,
    vectorIndex: vec,
    keywordIndex: keyword,
    factMirror: mirror,
    chunkStats: stats,
    clock,
    config: DEFAULT_RECALL_CONFIG,
    currentFacts: async () => ({ facts: (await ledger.listCurrent()).map(ledgerFactToRecord), damagedFiles: ledger.damagedFiles() }),
  });

  async function syncMirror(): Promise<void> {
    const records = [];
    for (const type of Object.keys(TYPE_TO_FILE) as FactType[]) {
      for (const f of await ledger.listAllOfType(type)) records.push(ledgerFactToRecord(f));
    }
    await mirror.rebuild(records);
  }

  function seedChunk(id: string, content: string, o: { lane?: string; createdAt?: string } = {}): void {
    const chunk: Chunk = {
      id, path: `${o.lane ?? 'memory'}/${id}.md`, lane: o.lane ?? 'narrative', content,
      startLine: 1, endLine: 2, createdAt: o.createdAt ?? NOW, embedding: conceptVector(content),
    };
    vec.upsert([chunk]);
    keyword.index([chunk]);
  }

  const writeSafety = (text: string): void => fs.writeFileSync(path.join(tmp, 'SAFETY.md'), text, 'utf8');

  beforeEach(() => {
    tmp = makeTestTemp('redacted-recall-accept-');
    dbPath = path.join(tmp, 'search.db');
    clock = fixedClock(NOW);
    ledger = new LedgerStore(tmp, clock);
    safety = new SafetyView(tmp, clock);
    mirror = new SqliteFactMirror({ dbPath });
    vec = new SqliteVecIndex({ dbPath, dimension: CONCEPTS.length });
    keyword = new SqliteKeywordIndex({ dbPath });
    stats = new SqliteChunkStats({ dbPath });
    assembler = new ContextAssembler({ reader: new MemoryEngine(tmp), safety, maxChars: 20000, clock });
  });
  afterEach(() => {
    for (const c of [mirror, vec, keyword, stats] as Array<{ close?: () => void }>) c.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a dormant knee injury is retrieved on "plan me a workout" (safety lowers threshold, decay=1)', async () => {
    await ledger.recordFact({
      entity: 'knee-injury', type: 'condition',
      fields: { diagnosis: 'MRI-confirmed mild MCL sprain' }, safetyRelevant: true, provenance: prov('doctor'),
    });
    await syncMirror();
    seedChunk('knee-archive', 'knee-injury recovery notes: ease back into exercise, avoid heavy leg loading and pivoting', { lane: 'episode', createdAt: daysAgo(150) });

    const report = await build().run({ profileId: 'default', userMessage: 'plan me a workout routine to get back in shape' });
    const ctx = (await assembler.assemble('default', 'chat', report)).content;
    expect(ctx).toContain('ease back into exercise'); // the dormant episode note, injected in RECALL
  });

  it('SAFETY is injected FIRST and non-truncatable, above any recall', async () => {
    writeSafety('## Allergies\n- penicillin — hives\n');
    seedChunk('knee-note', 'knee pain when running', { createdAt: NOW });
    const report = await build().run({ profileId: 'default', userMessage: 'workout ideas' });
    const asm = await assembler.assemble('default', 'chat', report);
    expect(asm.sections[0].key).toBe('SAFETY.md');
    expect(asm.sections[0].nonTruncatable).toBe(true);
    expect(asm.content.indexOf('penicillin')).toBeLessThan(asm.content.indexOf('knee pain'));
  });

  it('a discontinued med chunk is suppressed (fail-closed), never surfaced', async () => {
    await ledger.recordFact({ entity: 'naproxen', type: 'medication', fields: { dose: '500mg' }, provenance: prov('doctor') });
    const disc = await ledger.discontinue('naproxen', 'medication', prov('doctor'), { reason: 'switched' });
    if (disc.kind === 'needs-confirmation') await ledger.confirm(disc.token.uuid);
    await syncMirror();
    seedChunk('naproxen-note', 'naproxen helped the knee pain a lot', { createdAt: NOW });

    const report = await build().run({ profileId: 'default', userMessage: 'what about naproxen for my knee' });
    const ctx = (await assembler.assemble('default', 'chat', report)).content;
    expect(ctx).not.toContain('naproxen helped'); // the stale-entity narrative is dropped
  });

  it('Stage-1 ACTIVE HEALTH FACTS lists only active facts (a retracted one is absent)', async () => {
    await ledger.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: prov('user') });
    await ledger.recordFact({ entity: 'lisinopril', type: 'medication', fields: { dose: '10mg' }, provenance: prov('user') });
    const rm = await ledger.retract({ entity: 'metformin', type: 'medication', provenance: prov('user') });
    if (rm.kind === 'needs-confirmation' && rm.token) await ledger.confirm(rm.token.uuid);
    await syncMirror();

    const report = await build().run({ profileId: 'default', userMessage: 'what medications am I on' });
    const ctx = (await assembler.assemble('default', 'chat', report)).content;
    expect(ctx).toContain('lisinopril');
    expect(ctx).not.toContain('metformin');
  });

  it('time decay ranks a fresh knee note above an old one within the recall budget', async () => {
    seedChunk('fresh', 'knee soreness noted after the gym today', { createdAt: NOW });
    seedChunk('stale', 'knee twinge mentioned in passing long ago', { createdAt: daysAgo(300) });
    const report = await build().run({ profileId: 'default', userMessage: 'my knee and workout plan' });
    expect(report.hits.length).toBeGreaterThan(0);
    expect(report.hits[0].content).toContain('today'); // fresh outranks stale
  });

  it('a CHECK line correlates a recent med side effect with the symptom mention', async () => {
    await ledger.recordFact({
      entity: 'metformin', type: 'medication',
      fields: { dose: '500mg', started: daysAgo(20), known_side_effects: ['nausea', 'diarrhea'] },
      provenance: prov('user'),
    });
    await syncMirror();
    const report = await build().run({ profileId: 'default', userMessage: 'I keep feeling nausea lately' });
    expect(report.checkNotes).toContain('metformin');
    expect(report.checkNotes.toLowerCase()).toContain('nausea');
    const ctx = (await assembler.assemble('default', 'chat', report)).content;
    expect(ctx).toContain('CHECK:');
  });

  it('with embeddings down, recall degrades to keyword-only and surfaces the status flag', async () => {
    seedChunk('knee-note', 'knee pain after running', { createdAt: NOW });
    const report = await build(new ConceptEmbedding({ throwErr: true })).run({ profileId: 'default', userMessage: 'knee pain' });
    expect(report.indexStatus).toBe('keyword-only');
    expect(typeof report.narrative).toBe('string');
    expect(Array.isArray(report.hits)).toBe(true);
  });

  it('a ledger-lane chunk for an entity with a newer active head is suppressed', async () => {
    await ledger.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '1000mg' }, provenance: prov('user') });
    await syncMirror();
    seedChunk('metformin-old', 'metformin 500mg — earlier dose note', { lane: 'ledger', createdAt: daysAgo(30) });

    const report = await build().run({ profileId: 'default', userMessage: 'tell me about my metformin' });
    const ctx = (await assembler.assemble('default', 'chat', report)).content;
    expect(ctx).not.toContain('earlier dose note'); // superseded ledger chunk suppressed
    expect(ctx).toContain('metformin (medication) active'); // the active head still shows via Stage-1
  });

  it('a resolved lower-version active winner does not suppress its narrative entity', async () => {
    await mirror.upsert([
      {
        id: 'metformin@v2', profileId: 'default', entity: 'metformin', type: 'medication', version: 2,
        status: 'active', fields: { dose: '850mg' }, safetyRelevant: true, authority: 'doctor', confidence: 0.95,
        createdAt: '2026-08-22T00:00:00.000Z',
      },
      {
        id: 'metformin@v3', profileId: 'default', entity: 'metformin', type: 'medication', version: 3,
        status: 'superseded', fields: { dose: '500mg' }, safetyRelevant: true, authority: 'doctor', confidence: 0.95,
        createdAt: '2026-08-23T00:00:00.000Z',
      },
    ]);
    seedChunk('resolved-metformin', 'metformin narrative history remains relevant', { createdAt: NOW });

    const report = await build().run({ profileId: 'default', userMessage: 'tell me about metformin history' });
    expect(report.narrative).toContain('metformin narrative history remains relevant');
  });

  it('dormant recall stays within budget: at most finalTopK hits, under the narrative budget', async () => {
    for (let i = 0; i < 8; i++) seedChunk(`knee-${i}`, `knee soreness note number ${i} after a gym workout session`, { createdAt: NOW });
    const report = await build().run({ profileId: 'default', userMessage: 'knee and workout' });
    expect(report.hits.length).toBeGreaterThan(0);
    expect(report.hits.length).toBeLessThanOrEqual(DEFAULT_RECALL_CONFIG.finalTopK);
    expect(report.narrativeTokens).toBeLessThanOrEqual(DEFAULT_RECALL_CONFIG.narrativeBudget);
  });

  it('the assembled skeleton is cacheStable above the boundary; recall/runtime are below', async () => {
    writeSafety('## Medications\n- lisinopril — 10mg\n');
    seedChunk('knee-note', 'knee pain when running', { createdAt: NOW });
    const report = await build().run({ profileId: 'default', userMessage: 'workout' });
    const asm = await assembler.assemble('default', 'chat', report);
    const above = asm.sections.slice(0, asm.cacheBoundaryIndex);
    const below = asm.sections.slice(asm.cacheBoundaryIndex);
    expect(above.length).toBeGreaterThan(0);
    expect(above.every(s => s.cacheStable)).toBe(true);
    expect(below.every(s => !s.cacheStable)).toBe(true);
    const prefix = above.map(s => s.content).join('\n');
    expect(prefix).not.toContain('Today is');
  });
});
