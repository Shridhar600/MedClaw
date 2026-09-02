import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MemoryIndexer } from '../../src/memory/indexer';
import { SqliteStore } from '../../src/memory/sqlite-store';
import type { LLMProvider } from '../../src/providers/types';

const IndexerWithDelta = MemoryIndexer as unknown as {
  new (
    store: SqliteStore,
    provider: LLMProvider,
    workspace: string,
    profileId: string,
    deltaProvider: (relativePath: string) => unknown,
  ): MemoryIndexer;
};

describe('RR-9b delta indexing', () => {
  let tmpDir: string;
  let store: SqliteStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9b-index-'));
    store = new SqliteStore(path.join(tmpDir, 'search.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('embeds only appended delta content when the source fingerprint is current', async () => {
    const filePath = path.join(tmpDir, 'memory', '2026-08-18.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Array.from({ length: 900 }, (_, index) => `history-${index} ${'stable '.repeat(8)}`).join('\n') + '\n');
    const provider: LLMProvider = {
      modelName: 'rr9b-delta',
      chat: jest.fn(),
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    let pending: {
      hash: string;
      fingerprint: { mtimeMs: number; size: number; ino: number };
      chunks: Array<{ id: string; content: string; startLine: number; endLine: number }>;
    } | undefined;
    const indexer = new IndexerWithDelta(store, provider, tmpDir, 'default', () => {
      const next = pending;
      pending = undefined;
      return next;
    });
    await indexer.indexAll();
    (provider.embed as jest.Mock).mockClear();

    const appended = '- 14:30 — delta-only marker\n';
    fs.appendFileSync(filePath, appended);
    const stat = fs.statSync(filePath);
    pending = {
      hash: 'delta-final-hash',
      fingerprint: { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino },
      chunks: [{
        id: 'memory/2026-08-18.md:delta:901',
        content: appended.trimEnd(),
        startLine: 901,
        endLine: 901,
      }],
    };
    await indexer.indexFile('memory/2026-08-18.md');

    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith(appended.trimEnd());
    expect(store.getFileHash('memory/2026-08-18.md')).toBe('delta-final-hash');
    expect(store.getChunksByPath('memory/2026-08-18.md').some(chunk => chunk.content.includes('delta-only marker'))).toBe(true);
  });

  it('keeps the partial watermark when older chunks still lack vectors', async () => {
    const filePath = path.join(tmpDir, 'memory', '2026-08-18.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '# Existing history\n');
    let failHistoryEmbeds = true;
    let pending: {
      hash: string;
      fingerprint: { mtimeMs: number; size: number; ino: number };
      chunks: Array<{ id: string; content: string; startLine: number; endLine: number }>;
    } | undefined;
    const provider: LLMProvider = {
      modelName: 'rr9b-partial',
      chat: jest.fn(),
      embed: jest.fn().mockImplementation(async (text: string) => {
        if (text !== 'test' && failHistoryEmbeds) return [];
        return [0.1, 0.2, 0.3];
      }),
    };
    const indexer = new IndexerWithDelta(store, provider, tmpDir, 'default', () => {
      const next = pending;
      pending = undefined;
      return next;
    });
    await indexer.indexAll();
    expect(store.getFileHash('memory/2026-08-18.md')).toMatch(/^embedding-partial:/);

    failHistoryEmbeds = false;
    fs.appendFileSync(filePath, '- 14:30 — recovered delta\n');
    const stat = fs.statSync(filePath);
    pending = {
      hash: 'recovered-final-hash',
      fingerprint: { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino },
      chunks: [{
        id: 'memory/2026-08-18.md:delta:3',
        content: '- 14:30 — recovered delta',
        startLine: 3,
        endLine: 3,
      }],
    };
    await indexer.indexFile('memory/2026-08-18.md');

    expect(store.getFileHash('memory/2026-08-18.md')).toBe('embedding-partial:recovered-final-hash');
  });

  it('does not attempt per-chunk embeds after the dimension probe fails', async () => {
    const filePath = path.join(tmpDir, 'memory', 'probe-failure.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Array.from({ length: 120 }, (_, index) => `history-${index}`).join('\n'));
    const provider: LLMProvider = {
      modelName: 'rr9b-probe-failure',
      chat: jest.fn(),
      embed: jest.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    const indexer = new MemoryIndexer(store, provider, tmpDir);

    await indexer.indexAll();

    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith('test');
  });
});
