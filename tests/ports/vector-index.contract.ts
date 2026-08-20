// Shared VectorIndex contract (specs/16 §8). Any VectorIndex adapter must pass this
// suite — the liftability guarantee. Import and invoke it from an adapter's own
// *.test.ts, passing a factory that builds a fresh, isolated adapter per dimension.
//
// This file is NOT a test file itself (jest testMatch is **/*.test.ts) — it only
// exports the suite function.

import type { VectorIndex, Chunk, ChunkWithScore } from '../../src/ports';

export type ContractAdapter = VectorIndex & { close?: () => void };
export type MakeAdapter = (dimension: number) => ContractAdapter;

async function collect(it: AsyncIterable<ChunkWithScore>): Promise<ChunkWithScore[]> {
  const out: ChunkWithScore[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function chunk(id: string, embedding: number[], over: Partial<Chunk> = {}): Chunk {
  return {
    id,
    path: over.path ?? `${id}.md`,
    lane: over.lane ?? 'narrative',
    content: over.content ?? `content of ${id}`,
    startLine: over.startLine ?? 1,
    endLine: over.endLine ?? 2,
    createdAt: over.createdAt ?? '2026-08-12T00:00:00.000Z',
    embedding,
    ...over,
  };
}

export function runVectorIndexContract(makeAdapter: MakeAdapter): void {
  describe('VectorIndex contract (specs/16 §8)', () => {
    const DIM = 4;
    let idx: ContractAdapter;

    beforeEach(() => {
      idx = makeAdapter(DIM);
    });
    afterEach(() => {
      idx.close?.();
    });

    it('upserts chunks and knn returns the nearest first', async () => {
      await idx.upsert([
        chunk('a', [1, 0, 0, 0]),
        chunk('b', [0, 1, 0, 0]),
        chunk('c', [0, 0, 1, 0]),
      ]);
      const results = await collect(idx.queryKnn([0.9, 0.1, 0, 0], 2));
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe('a'); // nearest to [1,0,0,0]
      expect(results[0].score).toBeGreaterThan(0);
      // Returned rows carry the chunk metadata back.
      expect(results[0].path).toBe('a.md');
      expect(results[0].lane).toBe('narrative');
    });

    it('stats reports the chunk count and the fixed dimension', async () => {
      await idx.upsert([chunk('a', [1, 0, 0, 0]), chunk('b', [0, 1, 0, 0])]);
      const s = await idx.stats();
      expect(s.totalChunks).toBe(2);
      expect(s.dimension).toBe(DIM);
    });

    it('upsert on an existing id updates in place (idempotent, no duplicate)', async () => {
      await idx.upsert([chunk('a', [1, 0, 0, 0], { content: 'first' })]);
      await idx.upsert([chunk('a', [1, 0, 0, 0], { content: 'second' })]);
      const s = await idx.stats();
      expect(s.totalChunks).toBe(1);
      const results = await collect(idx.queryKnn([1, 0, 0, 0], 1));
      expect(results[0].content).toBe('second');
    });

    it('deleteByPath removes matching chunks and is idempotent', async () => {
      await idx.upsert([
        chunk('a', [1, 0, 0, 0], { path: 'keep.md' }),
        chunk('b', [0, 1, 0, 0], { path: 'drop.md' }),
      ]);
      await idx.deleteByPath('drop.md');
      await idx.deleteByPath('drop.md'); // second delete is a no-op, not an error
      const s = await idx.stats();
      expect(s.totalChunks).toBe(1);
      const results = await collect(idx.queryKnn([0, 1, 0, 0], 5));
      expect(results.find(r => r.id === 'b')).toBeUndefined();
    });

    it('rejects a query embedding whose dimension mismatches the index (B3)', async () => {
      await idx.upsert([chunk('a', [1, 0, 0, 0])]); // fixes the index dimension at 4
      await expect(collect(idx.queryKnn([1, 0, 0], 1))).rejects.toThrow(/dimension/i);
    });

    it('rejects an upsert whose embedding dimension mismatches the index (B3)', async () => {
      await idx.upsert([chunk('a', [1, 0, 0, 0])]);
      await expect(idx.upsert([chunk('z', [1, 0, 0])])).rejects.toThrow(/dimension/i);
    });
  });
}
