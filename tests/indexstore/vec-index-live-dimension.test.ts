import * as fs from 'fs';
import * as path from 'path';
import { SqliteVecIndex } from '../../src/indexstore';
import { makeTestTemp } from '../helpers/test-temp';

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const rows: unknown[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

describe('SqliteVecIndex live-path dimension', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = makeTestTemp('redacted-vecidx-live-');
    dbPath = path.join(dir, 'search.db');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('queryKnn returns rows when constructed WITHOUT a dimension over a pre-populated vec table', async () => {
    const writer = new SqliteVecIndex({ dbPath, dimension: 4 });
    await writer.upsert([{
      id: 'c1', path: 'memory/x.md', lane: '', content: 'insomnia notes waking at 3am',
      startLine: 1, endLine: 1, createdAt: '2026-01-01', embedding: [0.1, 0.2, 0.3, 0.4],
    }]);
    writer.close();

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
