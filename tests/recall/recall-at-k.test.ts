import * as fs from 'fs';
import * as path from 'path';
import { RecallEngine, DEFAULT_RECALL_CONFIG } from '../../src/recall';
import type { FactRecord, ChunkWithScore } from '../../src/ports';
import { FakeFactMirror, FakeVectorIndex, FakeKeywordIndex, FakeEmbedding, FakeChunkStats, fixedClock } from './fakes';

// P2 Wave B / Task B3.2 — golden recall@k measurement (the R3 minimum). Deterministic: mocked/
// frozen scores (no live Ollama) + injected clock (fixed ageDays). Expected ids are authored from
// SCENARIO semantics (specs/09 style), NOT from whatever the engine returns today — so the suite
// catches a systematic scoring/threshold/suppression bug, not snapshot drift. ≥50% of cases come
// from OUTSIDE the knee/diabetes families (risk #9). The per-case floor (recall@3 = 1.0 for these
// curated cases) is the regression baseline; retune consciously.

interface FixtureChunk {
  id: string; content: string; lane: string; createdAt: string; cosine: number; bm25n: number;
}
interface Fixture {
  name: string; family: string; clock: string; query: string;
  facts: Array<Partial<FactRecord> & { id: string; entity: string }>;
  chunks: FixtureChunk[];
  expectedChunkIds: string[];
  excludedChunkIds?: string[];
  floor?: number;
  /** When true, the embedding provider throws → keyword-only degrade path is exercised. */
  degrade?: boolean;
}

const KNEE_DIAB = new Set(['knee', 'diabetes']);

function frec(o: Partial<FactRecord> & { id: string; entity: string }): FactRecord {
  return {
    profileId: 'default', type: 'medication', version: 1, status: 'active',
    fields: {}, safetyRelevant: false, authority: 'user', confidence: 0.9,
    createdAt: '2026-08-01T00:00:00.000Z', ...o,
  };
}

function toHit(c: FixtureChunk, score: number): ChunkWithScore {
  return { id: c.id, path: `memory/${c.id}.md`, lane: c.lane, content: c.content, startLine: 1, endLine: 1, createdAt: c.createdAt, score };
}

function loadFixtures(): Fixture[] {
  const p = path.join(__dirname, '..', 'fixtures', 'recall', 'recall-at-k.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Fixture[];
}

describe('recall@k golden set (measurement minimum)', () => {
  const fixtures = loadFixtures();

  it('has ≥50% of cases from outside the knee/diabetes families', () => {
    const nonKneeDiab = fixtures.filter(f => !KNEE_DIAB.has(f.family)).length;
    expect(nonKneeDiab / fixtures.length).toBeGreaterThanOrEqual(0.5);
  });

  const recalls: number[] = [];
  const mrrs: number[] = [];

  it.each(fixtures.map(f => [f.name, f] as const))('%s — expected chunks in top-3', async (_name, f) => {
    const engine = new RecallEngine({
      embedding: new FakeEmbedding(f.degrade ? { throwErr: true } : { vector: [0.1, 0.2, 0.3] }),
      vectorIndex: new FakeVectorIndex(f.chunks.map(c => toHit(c, c.cosine))),
      keywordIndex: new FakeKeywordIndex(f.chunks.map(c => toHit(c, c.bm25n))),
      factMirror: new FakeFactMirror(f.facts.map(frec)),
      chunkStats: new FakeChunkStats(),
      clock: fixedClock(f.clock),
      config: DEFAULT_RECALL_CONFIG,
    });
    const r = await engine.run({ profileId: 'default', userMessage: f.query });
    const topIds = r.hits.map(h => h.id);

    const hitCount = f.expectedChunkIds.filter(id => topIds.includes(id)).length;
    const recallAtK = hitCount / f.expectedChunkIds.length;
    const firstRank = topIds.findIndex(id => f.expectedChunkIds.includes(id));
    recalls.push(recallAtK);
    mrrs.push(firstRank >= 0 ? 1 / (firstRank + 1) : 0);

    expect(recallAtK).toBeGreaterThanOrEqual(f.floor ?? 1.0);
    for (const ex of f.excludedChunkIds ?? []) expect(topIds).not.toContain(ex);
  });

  afterAll(() => {
    const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    // eslint-disable-next-line no-console
    console.log(`[recall@3] aggregate recall=${mean(recalls).toFixed(3)} MRR=${mean(mrrs).toFixed(3)} over ${recalls.length} cases`);
  });
});
