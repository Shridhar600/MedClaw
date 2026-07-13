import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteStore } from '../../src/memory/sqlite-store';

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

describe('vec0 ANN Search', () => {
  let tmpDir: string;
  let store: SqliteStore;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-vec0-'));
    store = new SqliteStore(path.join(tmpDir, 'test.db'));
    store.ensureVecTable(4);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    store.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('parity: vec0 KNN matches JS cosine scan top-K', () => {
    const embeddings: number[][] = [
      [1.0, 0.0, 0.0, 0.0],
      [0.0, 1.0, 0.0, 0.0],
      [0.0, 0.0, 1.0, 0.0],
      [0.0, 0.0, 0.0, 1.0],
      [0.5, 0.5, 0.0, 0.0],
      [0.0, 0.5, 0.5, 0.0],
      [0.0, 0.0, 0.5, 0.5],
      [0.5, 0.0, 0.5, 0.0],
      [0.0, 0.5, 0.0, 0.5],
      [0.5, 0.0, 0.0, 0.5],
    ];

    for (let i = 0; i < embeddings.length; i++) {
      store.upsertChunk({
        id: `chunk${i}:0`,
        path: 'test.md',
        content: `Content ${i}`,
        embedding: embeddings[i],
        startLine: i + 1,
        endLine: i + 1,
      });
    }

    const query = [0.9, 0.1, 0.0, 0.0];
    const queryFloat32 = new Float32Array(query);

    const allChunks = store.getAllChunksWithEmbeddings();
    const jsResults = allChunks
      .filter(c => c.embedding)
      .map(c => ({
        chunkId: c.id,
        score: cosineSimilarity(query, c.embedding!),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const vecResults = store.vectorSearch(queryFloat32, 5);

    expect(vecResults.length).toBeGreaterThan(0);
    // Top result should be chunk0 (most similar to query)
    expect(vecResults[0].chunkId).toBe('chunk0:0');
    // Both methods return the same set of top-K chunks (order may differ on ties)
    const vecIds = new Set(vecResults.map(r => r.chunkId));
    const jsIds = new Set(jsResults.map(r => r.chunkId));
    expect(vecIds).toEqual(jsIds);
  });

  it('WAL mode is active', () => {
    const row = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe('wal');
  });

  it('embedding model identity stored and readable', () => {
    store.setEmbeddingModel('test-model-v1');
    expect(store.getEmbeddingModel()).toBe('test-model-v1');
  });

  it('dimension mismatch handled gracefully', () => {
    const localWarn = jest.spyOn(console, 'warn').mockImplementation();
    store.upsertChunk({
      id: 'bad-dim:0',
      path: 'test.md',
      content: 'wrong dimension embedding',
      embedding: [0.1, 0.2, 0.3],
      startLine: 1,
      endLine: 1,
    });
    expect(localWarn).toHaveBeenCalledWith(
      expect.stringContaining('dimension'),
    );
    localWarn.mockRestore();
  });

  it('empty/NaN embedding logged as warning', () => {
    const localWarn = jest.spyOn(console, 'warn').mockImplementation();
    store.upsertChunk({
      id: 'nan-embed:0',
      path: 'test.md',
      content: 'NaN embedding',
      embedding: [NaN, 0.2, 0.3, 0.4],
      startLine: 1,
      endLine: 1,
    });
    expect(localWarn).toHaveBeenCalledWith(
      expect.stringContaining('NaN'),
    );
    localWarn.mockRestore();
  });

  it('profile-scoped indexes isolated', () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-vec0-2-'));
    const store2 = new SqliteStore(path.join(tmpDir2, 'test.db'));
    store2.ensureVecTable(4);

    store.upsertChunk({ id: 'profile1:0', path: 'p1.md', content: 'Profile 1 data', embedding: [1, 0, 0, 0], startLine: 1, endLine: 1 });
    store2.upsertChunk({ id: 'profile2:0', path: 'p2.md', content: 'Profile 2 data', embedding: [0, 1, 0, 0], startLine: 1, endLine: 1 });

    const results1 = store.vectorSearch(new Float32Array([1, 0, 0, 0]), 5);
    const results2 = store2.vectorSearch(new Float32Array([1, 0, 0, 0]), 5);

    expect(results1.some((r: { chunkId: string }) => r.chunkId === 'profile1:0')).toBe(true);
    expect(results1.some((r: { chunkId: string }) => r.chunkId === 'profile2:0')).toBe(false);
    expect(results2.some((r: { chunkId: string }) => r.chunkId === 'profile2:0')).toBe(true);
    expect(results2.some((r: { chunkId: string }) => r.chunkId === 'profile1:0')).toBe(false);

    store2.close();
    fs.rmSync(tmpDir2, { recursive: true });
  });

  // P0 gate: "Recall query < 200ms @ 5K chunks" (plan §P0 Gate Verification
  // Checklist). Uses the real embedding dimension (embeddinggemma = 768) and
  // deterministic synthetic vectors — no embedding provider needed.
  describe('P0 gate: ANN performance @ 5K chunks', () => {
    it('vectorSearch top-10 over 5000 chunks (768 dims) completes in <200ms', () => {
      const DIM = 768;
      const CHUNKS = 5000;
      const perfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-vec0-perf-'));
      const perfStore = new SqliteStore(path.join(perfDir, 'perf.db'));
      try {
        perfStore.ensureVecTable(DIM);

        // Deterministic pseudo-random vectors (mulberry32) so the test is
        // reproducible and needs no embedding provider.
        let seed = 0x9e3779b9;
        const rand = (): number => {
          seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const makeVec = (): number[] => Array.from({ length: DIM }, () => rand() * 2 - 1);

        for (let i = 0; i < CHUNKS; i++) {
          perfStore.upsertChunk({
            id: `perf-${i}:0`,
            path: `notes/perf-${i % 50}.md`,
            content: `Synthetic chunk ${i}`,
            embedding: makeVec(),
            startLine: 1,
            endLine: 3,
          });
        }

        const query = new Float32Array(makeVec());
        // Warm-up query (page cache, statement prep), then measure 3 runs
        // and gate on the median to damp CI jitter.
        perfStore.vectorSearch(query, 10);
        const timings: number[] = [];
        let results: ReturnType<typeof perfStore.vectorSearch> = [];
        for (let run = 0; run < 3; run++) {
          const start = performance.now();
          results = perfStore.vectorSearch(query, 10);
          timings.push(performance.now() - start);
        }

        // Guard: if sqlite-vec failed to load, vectorSearch returns [] instantly
        // and the timing would be meaningless — the gate requires real results.
        expect(results).toHaveLength(10);
        const median = timings.sort((a, b) => a - b)[1];
        expect(median).toBeLessThan(200);
      } finally {
        perfStore.close();
        fs.rmSync(perfDir, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
