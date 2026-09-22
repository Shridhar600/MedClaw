import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteVecIndex } from '../../src/indexstore';

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const rows: unknown[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

// C-1 regression: on the LIVE recall path the adapter is constructed without a dimension
// (`new SqliteVecIndex({ dbPath })`) and never upserts (the P0 store is the sole writer), so
// `this.dimension` was never fixed and queryKnn short-circuited to zero rows forever — silent
// semantic-recall death. queryKnn must lazily adopt the query embedding's dimension.
describe('SqliteVecIndex live-path dimension (C-1)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-vecidx-live-'));
    dbPath = path.join(dir, 'search.db');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('queryKnn returns rows when constructed WITHOUT a dimension over a pre-populated vec table', async () => {
    // A writer (like the P0 store) fixes the dimension and populates chunks + chunks_vec0.
    const writer = new SqliteVecIndex({ dbPath, dimension: 4 });
    await writer.upsert([{
      id: 'c1', path: 'memory/x.md', lane: '', content: 'insomnia notes waking at 3am',
      startLine: 1, endLine: 1, createdAt: '2026-01-01', embedding: [0.1, 0.2, 0.3, 0.4],
    }]);
    writer.close();

    // The recall READ adapter mirrors the live path: NO dimension passed.
    const reader = new SqliteVecIndex({ dbPath });
    const hits: string[] = [];
    for await (const h of reader.queryKnn([0.1, 0.2, 0.3, 0.4], 5)) hits.push(h.id);
    reader.close();

    expect(hits).toContain('c1');
  });

  it('rejects a query whose dimension differs from an existing vec table', async () => {
    const writer = new SqliteVecIndex({ dbPath, dimension: 4 });
    await writer.upsert([{
      id: 'c1', path: 'memory/x.md', lane: 'narrative', content: 'dimension mismatch',
      startLine: 1, endLine: 1, createdAt: '2026-01-01', embedding: [0.1, 0.2, 0.3, 0.4],
    }]);
    writer.close();

    const reader = new SqliteVecIndex({ dbPath });
    try {
      await expect(collect(reader.queryKnn([0.1, 0.2, 0.3], 5))).rejects.toThrow(/dimension/i);
    } finally {
      reader.close();
    }
  });

  it('raises when the vector extension is unavailable so recall can report a degraded arm', async () => {
    const reader = new SqliteVecIndex({ dbPath, dimension: 4 });
    (reader as unknown as { hasVec: boolean }).hasVec = false;
    try {
      await expect(collect(reader.queryKnn([0.1, 0.2, 0.3, 0.4], 5))).rejects.toThrow(/vector/i);
    } finally {
      reader.close();
    }
  });
});
