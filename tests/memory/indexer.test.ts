// tests/memory/indexer.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryIndexer } from '../../src/memory/indexer';
import { SqliteStore } from '../../src/memory/sqlite-store';
import type { LLMProvider } from '../../src/providers/types';

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

  it('keeps previous indexed chunks when embedding fails during reindex', async () => {
    const filePath = path.join(workspaceDir, 'stable.md');
    fs.writeFileSync(filePath, '# Original\n\nBaseline content.');

    const indexer = new MemoryIndexer(store, mockProvider, workspaceDir);
    await indexer.indexAll();
    expect(store.getChunksByPath('stable.md')[0].content).toContain('Baseline content');

    fs.writeFileSync(filePath, '# Updated\n\nNew content that fails embedding.');
    (mockProvider.embed as jest.Mock).mockRejectedValueOnce(new Error('transient embed failure'));

    await indexer.indexAll();
    const chunksAfterFailure = store.getChunksByPath('stable.md');
    expect(chunksAfterFailure.length).toBeGreaterThan(0);
    expect(chunksAfterFailure[0].content).toContain('Baseline content');
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
});
