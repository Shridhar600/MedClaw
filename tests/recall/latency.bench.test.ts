import { RecallEngine, DEFAULT_RECALL_CONFIG } from '../../src/recall';
import type { FactRecord, ChunkWithScore } from '../../src/ports';
import { FakeFactMirror, FakeVectorIndex, FakeKeywordIndex, FakeEmbedding, FakeChunkStats, fixedClock } from './fakes';

// P2 Wave B / Task B3.3 — recall latency bench. Embeddings are MOCKED (instant), so this measures
// the engine's OWN per-turn compute (hybrid merge + scoreChunk + suppression matching + render)
// against a large index + many ledger entity heads — a regression guard against an accidental
// O(n²) blow-up. The B1 p95≤800ms gate WITH LOCAL EMBEDDINGS (PLAT-18) is an integration concern
// needing a live Ollama (deferred with the instrumentation program); P0 already proved 52ms raw KNN
// over 5K chunks. This bench keeps the pure path far under the 800ms budget.

const P95_BUDGET_MS = 800;

function bigChunks(n: number): ChunkWithScore[] {
  const out: ChunkWithScore[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `c${i}`, path: `memory/d${i % 90}.md`, lane: i % 3 === 0 ? 'episode' : 'narrative',
      content: `health note ${i} about sleep mood energy and general wellbeing tracking`,
      startLine: 1, endLine: 1, createdAt: '2026-09-25T00:00:00.000Z', score: 0.6 + (i % 40) / 100,
    });
  }
  return out;
}

function manyHeads(n: number): FactRecord[] {
  const out: FactRecord[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `f${i}`, profileId: 'default', entity: `entity-${i}`, type: 'condition', version: 1,
      status: 'active', fields: {}, safetyRelevant: false, authority: 'user', confidence: 0.9,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

describe('recall latency bench', () => {
  it('per-turn recall stays well under the p95 budget over a 5K index + 300 heads', async () => {
    const engine = new RecallEngine({
      embedding: new FakeEmbedding({ vector: [0.1, 0.2, 0.3] }),
      vectorIndex: new FakeVectorIndex(bigChunks(5000)),
      keywordIndex: new FakeKeywordIndex(bigChunks(5000)),
      factMirror: new FakeFactMirror(manyHeads(300)),
      chunkStats: new FakeChunkStats(),
      clock: fixedClock('2026-10-01T00:00:00.000Z'),
      config: DEFAULT_RECALL_CONFIG,
    });

    const runs = 40;
    const durations: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await engine.run({ profileId: 'default', userMessage: 'how has my sleep and mood been lately' });
      durations.push(performance.now() - t0);
    }
    durations.sort((a, b) => a - b);
    const p95 = percentile(durations, 95);
    // eslint-disable-next-line no-console
    console.log(`[recall latency] p50=${percentile(durations, 50).toFixed(2)}ms p95=${p95.toFixed(2)}ms over ${runs} runs`);
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });
});
