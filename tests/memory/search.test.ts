import { MemorySearch } from '../../src/memory/search';
import { SqliteStore } from '../../src/memory/sqlite-store';
import type { LLMProvider } from '../../src/providers/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('MemorySearch', () => {
  let tmpDir: string;
  let store: SqliteStore;

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  describe('basic queries', () => {
    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-search-'));
      store = new SqliteStore(path.join(tmpDir, 'test.db'));
    });

    it('returns results for a query', async () => {
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockResolvedValue([1.0, 0.0, 0.0]),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.7, keyword: 0.3 });
      store.upsertChunk({ id: 'a.md:0', path: 'a.md', content: 'diabetes blood sugar control', embedding: [1.0, 0.0, 0.0], startLine: 1, endLine: 1 });
      store.upsertChunk({ id: 'b.md:0', path: 'b.md', content: 'knee injury recovery exercises', embedding: [0.0, 1.0, 0.0], startLine: 1, endLine: 1 });
      store.upsertChunk({ id: 'c.md:0', path: 'c.md', content: 'medication metformin schedule', embedding: [0.0, 0.0, 1.0], startLine: 1, endLine: 1 });

      const results = await search.search('diabetes', 3);
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns top-K results', async () => {
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockResolvedValue([1.0, 0.0, 0.0]),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.7, keyword: 0.3 });
      store.upsertChunk({ id: 'a.md:0', path: 'a.md', content: 'diabetes blood sugar control', embedding: [1.0, 0.0, 0.0], startLine: 1, endLine: 1 });
      store.upsertChunk({ id: 'b.md:0', path: 'b.md', content: 'knee injury recovery exercises', embedding: [0.0, 1.0, 0.0], startLine: 1, endLine: 1 });
      store.upsertChunk({ id: 'c.md:0', path: 'c.md', content: 'medication metformin schedule', embedding: [0.0, 0.0, 1.0], startLine: 1, endLine: 1 });

      const results = await search.search('health', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('hybrid merge with known embeddings', () => {
    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-search-'));
      store = new SqliteStore(path.join(tmpDir, 'test.db'));
    });

    it('computes combined score from both vector and keyword results', async () => {
      // Query embedding matches a.md exactly → cosine similarity = 1.0
      // BM25 also matches a.md for "diabetes" query
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockResolvedValue([1.0, 0.0, 0.0]),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.7, keyword: 0.3 });
      store.upsertChunk({ id: 'a.md:0', path: 'a.md', content: 'diabetes blood sugar control', embedding: [1.0, 0.0, 0.0], startLine: 1, endLine: 1 });
      store.upsertChunk({ id: 'b.md:0', path: 'b.md', content: 'knee injury recovery exercises', embedding: [0.0, 1.0, 0.0], startLine: 1, endLine: 1 });

      const results = await search.search('diabetes', 2);
      // a.md appears in both vector (cosine=1.0) and keyword (bm25) results
      const aResult = results.find(r => r.path === 'a.md');
      expect(aResult).toBeDefined();
      // Vector component: 0.7 * 1.0 = 0.7, keyword component > 0
      // Combined must be > 0.7 (keyword adds something) and < 1.0
      expect(aResult!.score).toBeGreaterThan(0.7);
      expect(aResult!.score).toBeLessThanOrEqual(1.0);
    });
  });

  describe('deduplication', () => {
    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-search-'));
      store = new SqliteStore(path.join(tmpDir, 'test.db'));
    });

    it('does not collapse distinct relevant chunks from the same path', async () => {
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockResolvedValue([1.0, 0.0, 0.0]),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.7, keyword: 0.3 });
      store.upsertChunk({ id: 'a.md:0', path: 'a.md', content: 'diabetes blood sugar control', embedding: [1.0, 0.0, 0.0], startLine: 1, endLine: 4 });
      store.upsertChunk({ id: 'a.md:1', path: 'a.md', content: 'diabetes evening meal notes', embedding: [1.0, 0.0, 0.0], startLine: 20, endLine: 24 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await search.search('diabetes', 5) as any[];
      const occurrences = results.filter(r => r.path === 'a.md');
      expect(occurrences).toHaveLength(2);
      expect(new Set(occurrences.map(r => r.chunkId)).size).toBe(2);
      expect(occurrences[0].startLine).toBeDefined();
      expect(occurrences[0].endLine).toBeDefined();
    });
  });

  describe('chunk metadata', () => {
    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-search-'));
      store = new SqliteStore(path.join(tmpDir, 'test.db'));
    });

    it('returns chunk-level metadata including chunkId and line range', async () => {
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockResolvedValue([1.0, 0.0, 0.0]),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.7, keyword: 0.3 });
      store.upsertChunk({
        id: 'notes.md:2',
        path: 'notes.md',
        content: 'glucose trend section',
        embedding: [1.0, 0.0, 0.0],
        startLine: 42,
        endLine: 55,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await search.search('glucose trend', 3) as any[];
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chunkId).toBe('notes.md:2');
      expect(results[0].startLine).toBe(42);
      expect(results[0].endLine).toBe(55);
    });
  });

  describe('empty result set', () => {
    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-search-'));
      store = new SqliteStore(path.join(tmpDir, 'test.db'));
    });

    it('returns empty array when no chunks match', async () => {
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockResolvedValue([1.0, 0.0, 0.0]),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.7, keyword: 0.3 });
      // No chunks inserted

      const results = await search.search('diabetes', 5);
      expect(results).toEqual([]);
    });
  });

  describe('keyword ranking order', () => {
    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-search-'));
      store = new SqliteStore(path.join(tmpDir, 'test.db'));
    });

    it('ranks stronger keyword matches above weaker ones in hybrid search', async () => {
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockResolvedValue([0.1, 0.1, 0.1]),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.7, keyword: 0.3 });
      store.upsertChunk({ id: 'strong.md:0', path: 'strong.md', content: 'diabetes blood sugar control diabetes management', embedding: undefined, startLine: 1, endLine: 1 });
      store.upsertChunk({ id: 'weak.md:0', path: 'weak.md', content: 'diabetes symptoms', embedding: undefined, startLine: 1, endLine: 1 });

      const results = await search.search('diabetes', 2);
      expect(results.length).toBe(2);
      expect(results[0].path).toBe('strong.md');
      expect(results[1].path).toBe('weak.md');
    });

    it('ranks stronger keyword matches above weaker ones even when vector weights are zero', async () => {
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockResolvedValue([0.1, 0.1, 0.1]),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.0, keyword: 1.0 });
      store.upsertChunk({ id: 'strong2.md:0', path: 'strong2.md', content: 'diabetes blood sugar control diabetes management', embedding: undefined, startLine: 1, endLine: 1 });
      store.upsertChunk({ id: 'weak2.md:0', path: 'weak2.md', content: 'diabetes symptoms', embedding: undefined, startLine: 1, endLine: 1 });

      const results = await search.search('diabetes', 2);
      expect(results.length).toBe(2);
      expect(results[0].path).toBe('strong2.md');
      expect(results[1].path).toBe('weak2.md');
    });
  });

  describe('graceful degradation', () => {
    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-search-'));
      store = new SqliteStore(path.join(tmpDir, 'test.db'));
    });

    it('still returns keyword-only results when vector search fails', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockRejectedValue(new Error('embedder unavailable')),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.7, keyword: 0.3 });
      store.upsertChunk({ id: 'a.md:0', path: 'a.md', content: 'diabetes blood sugar control', embedding: [1.0, 0.0, 0.0], startLine: 1, endLine: 1 });

      const results = await search.search('diabetes', 5);

      expect(results.length).toBeGreaterThan(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[search] Vector search failed'),
        expect.anything(),
      );
      warnSpy.mockRestore();
    });

    it('does not throw on punctuation-heavy natural language queries', async () => {
      const mockProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockRejectedValue(new Error('embedder unavailable')),
      };
      const search = new MemorySearch(store, mockProvider, { vector: 0.7, keyword: 0.3 });
      store.upsertChunk({
        id: 'right-knee.md:0',
        path: 'right-knee.md',
        content: 'knee pain right side after workout',
        embedding: [1.0, 0.0, 0.0],
        startLine: 1,
        endLine: 1,
      });

      await expect(search.search('knee pain (right)?', 5)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'right-knee.md' }),
        ]),
      );
    });
  });
});
