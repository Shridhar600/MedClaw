// tests/memory/indexer.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryIndexer } from '../../src/memory/indexer';
import { SqliteStore } from '../../src/memory/sqlite-store';
import type { LLMProvider } from '../../src/providers/types';
import { SqliteKeywordIndex } from '../../src/indexstore';

describe('MemoryIndexer', () => {
  let tmpDir: string;
  let store: SqliteStore;
  let mockProvider: LLMProvider;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-indexer-'));
    workspaceDir = tmpDir;
    store = new SqliteStore(path.join(tmpDir, 'test.db'));
    mockProvider = {
      chat: jest.fn(),
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4, 0.5]),
    };
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('indexAll() stores chunks in SQLite', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'test.md'), '# Test\n\nSome content here.');
    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();

    const chunks = store.getChunksByPath('test.md');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toContain('Test');
  });

  it('re-indexing same file skips unchanged via hash', async () => {
    const filePath = path.join(workspaceDir, 'skip.md');
    fs.writeFileSync(filePath, '# Skip Test\n\nContent unchanged.');

    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();
    const firstEmbedCallCount = (mockProvider.embed as jest.Mock).mock.calls.length;

    await indexer.indexAll();
    const secondEmbedCallCount = (mockProvider.embed as jest.Mock).mock.calls.length;

    expect(secondEmbedCallCount).toBe(firstEmbedCallCount);
  });

  it('modified file gets re-indexed', async () => {
    const filePath = path.join(workspaceDir, 'modify.md');
    fs.writeFileSync(filePath, '# Original');

    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();
    const firstEmbedCallCount = (mockProvider.embed as jest.Mock).mock.calls.length;

    fs.writeFileSync(filePath, '# Modified\n\nNew content here.');

    await indexer.indexAll();
    const secondEmbedCallCount = (mockProvider.embed as jest.Mock).mock.calls.length;

    expect(secondEmbedCallCount).toBeGreaterThan(firstEmbedCallCount);
  });

  it('chunking produces multiple chunks with overlap for long content', async () => {
    const longContent = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'word '.repeat(10)}`).join('\n');
    fs.writeFileSync(path.join(workspaceDir, 'long.md'), longContent);

    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();

    const chunks = store.getChunksByPath('long.md');
    expect(chunks.length).toBeGreaterThan(1);
    const ids = chunks.map(c => c.id);
    const chunkIndices = ids.map(id => parseInt(id.split(':')[1], 10));
    expect(chunkIndices[1]).toBeGreaterThan(0);
  });

  it('skips files with no content', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'empty.md'), '');
    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();

    const chunks = store.getChunksByPath('empty.md');
    expect(chunks.length).toBe(0);
  });

  it('replaces previous indexed chunks when embedding fails during reindex', async () => {
    const filePath = path.join(workspaceDir, 'stable.md');
    fs.writeFileSync(filePath, '# Original\n\nBaseline content.');

    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();
    expect(store.getChunksByPath('stable.md')[0].content).toContain('Baseline content');

    fs.writeFileSync(filePath, '# Updated\n\nNew content that fails embedding.');
    (mockProvider.embed as jest.Mock).mockRejectedValueOnce(new Error('transient embed failure'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    await indexer.indexAll();
    const chunksAfterFailure = store.getChunksByPath('stable.md');
    expect(chunksAfterFailure.length).toBeGreaterThan(0);
    expect(chunksAfterFailure[0].content).toContain('New content that fails embedding');
    expect(store.getAllChunksWithEmbeddings().find(chunk => chunk.path === 'stable.md')?.embedding).toBeUndefined();
    expect(store.keywordSearch('fails embedding', 5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'stable.md' }),
      ]),
    );
    warnSpy.mockRestore();
  });

  it('stores failed-embedding chunks without embeddings so updated files remain keyword searchable', async () => {
    const filePath = path.join(workspaceDir, 'partial.md');
    const lines = Array.from({ length: 90 }, (_, i) => {
      const marker = i === 45 ? 'chunk-two-failure-token' : `line-${i}`;
      return `${marker} ${'memory resilience keyword '.repeat(10)}`;
    });
    fs.writeFileSync(filePath, lines.join('\n'));

    (mockProvider.embed as jest.Mock).mockImplementation(async (content: string) => {
      if (content.includes('chunk-two-failure-token')) {
        throw new Error('transient chunk embed failure');
      }
      return [0.1, 0.2, 0.3];
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();

    const chunks = store.getAllChunksWithEmbeddings().filter(chunk => chunk.path === 'partial.md');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some(chunk => chunk.embedding === undefined)).toBe(true);
    expect(chunks.some(chunk => chunk.embedding !== undefined)).toBe(true);
    expect(store.keywordSearch('chunk-two-failure-token', 5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'partial.md' }),
      ]),
    );
    expect(store.getFileHash('partial.md')).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[indexer] Failed to embed chunk partial.md:'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('retries failed indexing on next run when file content is unchanged', async () => {
    const filePath = path.join(workspaceDir, 'retry.md');
    fs.writeFileSync(filePath, '# First');
    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();

    fs.writeFileSync(filePath, '# Second\n\nNeeds retry after transient failure.');
    (mockProvider.embed as jest.Mock).mockRejectedValueOnce(new Error('transient embed failure'));
    await indexer.indexAll();

    (mockProvider.embed as jest.Mock).mockResolvedValue([0.2, 0.3, 0.4]);
    await indexer.indexAll();

    const chunks = store.getChunksByPath('retry.md');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toContain('Needs retry');
  });

  it('prunes deleted files from chunks and file hashes during full indexing', async () => {
    const keepPath = path.join(workspaceDir, 'keep.md');
    const deletePath = path.join(workspaceDir, 'delete.md');
    fs.writeFileSync(keepPath, '# Keep');
    fs.writeFileSync(deletePath, '# Delete');

    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();
    expect(store.getChunksByPath('delete.md').length).toBeGreaterThan(0);
    expect(store.getFileHash('delete.md')).toBeDefined();

    fs.unlinkSync(deletePath);
    await indexer.indexAll();

    expect(store.getChunksByPath('delete.md')).toHaveLength(0);
    expect(store.getFileHash('delete.md')).toBeUndefined();
    expect(store.getChunksByPath('keep.md').length).toBeGreaterThan(0);
  });

  it('writes canonical lane and created_at metadata for live v2 adapter reads', async () => {
    fs.mkdirSync(path.join(workspaceDir, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'ledger', 'medications.md'), '## metformin\n- dose: 500mg\n');

    await new MemoryIndexer(store, mockProvider, workspaceDir).indexAll();

    const keyword = new SqliteKeywordIndex({ dbPath: path.join(tmpDir, 'test.db') });
    try {
      const hits = [];
      for await (const hit of keyword.match('metformin', 5)) hits.push(hit);
      expect(hits).toEqual(expect.arrayContaining([
        expect.objectContaining({ lane: 'ledger', createdAt: expect.stringMatching(/\S/) }),
      ]));
    } finally {
      keyword.close();
    }
  });

  it('re-embeds an unchanged file when the embedding model changes', async () => {
    const filePath = path.join(workspaceDir, 'model-change.md');
    fs.writeFileSync(filePath, '# Model change\n\nmodel identity must invalidate old vectors.');

    const oldProvider: LLMProvider = {
      modelName: 'model-old',
      chat: jest.fn(),
      embed: jest.fn().mockResolvedValue([1, 0]),
    };
    await new MemoryIndexer(store, oldProvider, workspaceDir).indexAll();

    const newProvider: LLMProvider = {
      modelName: 'model-new',
      chat: jest.fn(),
      embed: jest.fn().mockResolvedValue([0, 1]),
    };
    await new MemoryIndexer(store, newProvider, workspaceDir).indexAll();

    expect((newProvider.embed as jest.Mock).mock.calls.some(([text]) => text !== 'test')).toBe(true);
    expect(store.getAllChunksWithEmbeddings()[0].embedding).toEqual([0, 1]);
  });

  it('leaves an empty resolved embedding file dirty instead of marking it current', async () => {
    const filePath = path.join(workspaceDir, 'empty-vector.md');
    fs.writeFileSync(filePath, '# Empty vector\n\nThis chunk has no usable embedding.');
    const provider: LLMProvider = {
      modelName: 'empty-vector-model',
      chat: jest.fn(),
      embed: jest.fn().mockImplementation(async (text: string) => text === 'test' ? [1, 0] : []),
    };

    await new MemoryIndexer(store, provider, workspaceDir).indexAll();

    expect(store.getFileHash('empty-vector.md')).toMatch(/^embedding-partial:/);
    expect(store.getAllChunksWithEmbeddings().find(chunk => chunk.path === 'empty-vector.md')?.embedding)
      .toBeUndefined();
  });

  it('does not destroy an existing vector table when the dimension probe fails', async () => {
    const filePath = path.join(workspaceDir, 'probe-outage.md');
    fs.writeFileSync(filePath, '# Probe outage\n\nExisting vector content.');
    const healthy: LLMProvider = {
      modelName: 'stable-model',
      chat: jest.fn(),
      embed: jest.fn().mockResolvedValue([1, 0, 0, 0]),
    };
    await new MemoryIndexer(store, healthy, workspaceDir).indexAll();
    const beforeDimension = (store.db.prepare("SELECT value FROM meta WHERE key = 'embedding_dimension'").get() as { value: string }).value;
    const beforeVectors = (store.db.prepare('SELECT COUNT(*) AS count FROM chunks_vec0').get() as { count: number }).count;

    const outage: LLMProvider = {
      modelName: 'stable-model',
      chat: jest.fn(),
      embed: jest.fn().mockRejectedValue(new Error('embedding outage')),
    };
    await new MemoryIndexer(store, outage, workspaceDir).indexAll();

    const afterDimension = (store.db.prepare("SELECT value FROM meta WHERE key = 'embedding_dimension'").get() as { value: string }).value;
    const afterVectors = (store.db.prepare('SELECT COUNT(*) AS count FROM chunks_vec0').get() as { count: number }).count;
    expect(afterDimension).toBe(beforeDimension);
    expect(afterVectors).toBe(beforeVectors);
  });

  it('does not publish an older embedding after a newer same-path index finishes', async () => {
    const filePath = path.join(workspaceDir, 'race.md');
    fs.writeFileSync(filePath, '# Baseline');
    let releaseOld!: () => void;
    let signalOldStarted!: () => void;
    const started = new Promise<void>(resolve => { signalOldStarted = resolve; });
    const provider: LLMProvider = {
      modelName: 'race-model',
      chat: jest.fn(),
      embed: jest.fn().mockImplementation(async (text: string) => {
        if (text === 'test') return [1, 0];
        if (text.includes('OLD')) {
          signalOldStarted();
          await new Promise<void>(resolve => { releaseOld = resolve; });
          return [1, 0];
        }
        return [0, 1];
      }),
    };
    await new MemoryIndexer(store, provider, workspaceDir).indexAll();

    fs.writeFileSync(filePath, '# OLD content');
    const indexOld = new MemoryIndexer(store, provider, workspaceDir).indexFile('race.md');
    await started;
    fs.writeFileSync(filePath, '# NEW content');
    const indexNew = new MemoryIndexer(store, provider, workspaceDir).indexFile('race.md');
    await indexNew;
    releaseOld();
    await indexOld;

    expect(store.getChunksByPath('race.md')[0].content).toContain('NEW content');
  });
});
