// tests/memory/sqlite-store.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteStore } from '../../src/memory/sqlite-store';
import type { Chunk } from '../../src/memory/types';

describe('SqliteStore', () => {
  let tmpDir: string;
  let store: SqliteStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sqlite-'));
    store = new SqliteStore(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('upserts chunks and retrieves by path', () => {
    const chunk: Chunk = {
      id: 'SOUL.md:0',
      path: 'SOUL.md',
      content: 'You are a health companion.',
      embedding: [0.1, 0.2, 0.3],
      startLine: 1,
      endLine: 1,
    };
    store.upsertChunk(chunk);
    const retrieved = store.getChunksByPath('SOUL.md');
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].content).toBe('You are a health companion.');
  });

  it('deletes chunks by path', () => {
    store.upsertChunk({ id: 'x.md:0', path: 'x.md', content: 'test', embedding: [1, 0, 0], startLine: 1, endLine: 1 });
    store.deleteByPath('x.md');
    expect(store.getChunksByPath('x.md')).toHaveLength(0);
  });

  it('does keyword (BM25-like) search', () => {
    store.upsertChunk({ id: 'a.md:0', path: 'a.md', content: 'diabetes management tips', embedding: [1, 0, 0], startLine: 1, endLine: 1 });
    store.upsertChunk({ id: 'b.md:0', path: 'b.md', content: 'workout routine for beginners', embedding: [0, 1, 0], startLine: 1, endLine: 1 });
    const results = store.keywordSearch('diabetes', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('a.md');
  });
});
