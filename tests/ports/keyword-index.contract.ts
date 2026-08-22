// Shared KeywordIndex contract (P2 Task A2). Any KeywordIndex adapter must pass this suite —
// the FTS keyword arm of hybrid recall (Stage 2). NOT a test file itself; invoked from an
// adapter's own *.test.ts with a factory that builds a fresh, isolated adapter per call.

import type { KeywordIndex, Chunk, ChunkWithScore } from '../../src/ports';

export type ContractKeywordIndex = KeywordIndex & { close?: () => void };
export type MakeKeywordIndex = () => ContractKeywordIndex;

async function collect(it: AsyncIterable<ChunkWithScore>): Promise<ChunkWithScore[]> {
  const out: ChunkWithScore[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function chunk(id: string, content: string, over: Partial<Chunk> = {}): Chunk {
  return {
    id,
    path: over.path ?? `${id}.md`,
    lane: over.lane ?? 'narrative',
    content,
    startLine: over.startLine ?? 1,
    endLine: over.endLine ?? 2,
    createdAt: over.createdAt ?? '2026-08-12T00:00:00.000Z',
    ...over,
  };
}

export function runKeywordIndexContract(makeIndex: MakeKeywordIndex): void {
  describe('KeywordIndex contract (P2 A2)', () => {
    let idx: ContractKeywordIndex;

    beforeEach(() => {
      idx = makeIndex();
    });
    afterEach(() => {
      idx.close?.();
    });

    it('indexes chunks and match returns a hit carrying metadata', async () => {
      await idx.index([
        chunk('a', 'started naproxen 500mg for the knee'),
        chunk('b', 'movie night was fun'),
      ]);
      const hits = await collect(idx.match('naproxen', 5));
      expect(hits.map(h => h.id)).toContain('a');
      expect(hits.find(h => h.id === 'a')?.path).toBe('a.md');
      expect(hits.find(h => h.id === 'a')?.lane).toBe('narrative');
      expect(hits.find(h => h.id === 'b')).toBeUndefined();
    });

    it('scores are normalized into (0, 1]', async () => {
      await idx.index([chunk('a', 'naproxen naproxen naproxen dose')]);
      const [hit] = await collect(idx.match('naproxen', 5));
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    });

    it('deleteByPath removes matching chunks and is idempotent', async () => {
      await idx.index([
        chunk('a', 'naproxen for knee', { path: 'keep.md' }),
        chunk('b', 'naproxen for ankle', { path: 'drop.md' }),
      ]);
      await idx.deleteByPath('drop.md');
      await idx.deleteByPath('drop.md'); // no-op, not an error
      const hits = await collect(idx.match('naproxen', 5));
      expect(hits.map(h => h.id)).toEqual(['a']);
    });

    it('filters by lane', async () => {
      await idx.index([
        chunk('a', 'metformin dose', { lane: 'ledger' }),
        chunk('b', 'metformin chatter', { lane: 'narrative' }),
      ]);
      const hits = await collect(idx.match('metformin', 5, { lane: 'ledger' }));
      expect(hits.map(h => h.id)).toEqual(['a']);
    });

    it('re-indexing the same id updates in place (no duplicate hit)', async () => {
      await idx.index([chunk('a', 'ibuprofen first')]);
      await idx.index([chunk('a', 'ibuprofen second version')]);
      const hits = await collect(idx.match('ibuprofen', 5));
      expect(hits).toHaveLength(1);
      expect(hits[0].content).toBe('ibuprofen second version');
    });

    it('an empty / punctuation-only query returns no results (never throws)', async () => {
      await idx.index([chunk('a', 'naproxen for knee')]);
      expect(await collect(idx.match('', 5))).toEqual([]);
      expect(await collect(idx.match('   !!! ', 5))).toEqual([]);
    });
  });
}
