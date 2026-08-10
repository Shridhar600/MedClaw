import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemoryTools } from '../../src/tools/memory-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';
import { SqliteStore } from '../../src/memory/sqlite-store';
import { MemoryIndexer } from '../../src/memory/indexer';
import type { LLMProvider } from '../../src/providers/types';

describe('Memory Write Reindex', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let store: SqliteStore;
  let indexer: MemoryIndexer;
  let mockProvider: LLMProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-reindex-'));
    engine = new MemoryEngine(tmpDir);
    store = new SqliteStore(path.join(tmpDir, 'test.db'));
    mockProvider = {
      chat: jest.fn(),
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    };
    indexer = new MemoryIndexer(store, mockProvider, tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('memory_write triggers indexFile via indexer', async () => {
    const indexSpy = jest.spyOn(indexer, 'indexFile');
    const tools = createMemoryTools(engine, undefined, indexer);
    const tool = tools.find(t => t.name === 'memory_write')!;

    await tool.execute({ path: 'test.md', content: '# Test Content', mode: 'overwrite' });

    expect(indexSpy).toHaveBeenCalledWith('test.md');
    indexSpy.mockRestore();
  });

  it('search returns content after write-triggered reindex', async () => {
    const tools = createMemoryTools(engine, undefined, indexer);
    const writeTool = tools.find(t => t.name === 'memory_write')!;
    await writeTool.execute({ path: 'health.md', content: 'blood sugar level 120', mode: 'overwrite' });

    // Give indexer time to process (fire-and-forget)
    await new Promise(r => setTimeout(r, 200));

    const chunks = store.getChunksByPath('health.md');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toContain('blood sugar level 120');
  });

  it('append also triggers reindex', async () => {
    const indexSpy = jest.spyOn(indexer, 'indexFile');
    const tools = createMemoryTools(engine, undefined, indexer);
    const writeTool = tools.find(t => t.name === 'memory_write')!;

    await writeTool.execute({ path: 'log.md', content: 'Initial content', mode: 'overwrite' });
    indexSpy.mockClear();
    await writeTool.execute({ path: 'log.md', content: 'Appended line', mode: 'append' });

    expect(indexSpy).toHaveBeenCalledWith('log.md');
    indexSpy.mockRestore();
  });

  it('memory_write with no indexer does not throw', async () => {
    const tools = createMemoryTools(engine, undefined, undefined);
    const tool = tools.find(t => t.name === 'memory_write')!;

    await expect(tool.execute({ path: 'test.md', content: 'No indexer test', mode: 'overwrite' })).resolves.toBeDefined();
  });
});
