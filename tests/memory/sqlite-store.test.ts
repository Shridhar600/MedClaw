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

// ── RES-P0-3: corrupt DB quarantine + fresh rebuild ──────────────────────
describe('SqliteStore corruption recovery (RES-P0-3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sqlite-corrupt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('quarantines a corrupt DB (+ -wal/-shm) and opens a fresh, functional index instead of throwing', () => {
    const dbPath = path.join(tmpDir, 'corrupt.db');
    fs.writeFileSync(dbPath, Buffer.from('this is not a sqlite database — garbage bytes PHI glucose 300'));
    fs.writeFileSync(`${dbPath}-wal`, Buffer.from('wal garbage bytes chest pain'));
    fs.writeFileSync(`${dbPath}-shm`, Buffer.from('shm garbage'));

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    let recovered: SqliteStore;
    expect(() => {
      recovered = new SqliteStore(dbPath, 'default');
    }).not.toThrow();

    // A quarantine file exists for the corrupt main DB.
    const entries = fs.readdirSync(tmpDir);
    const quarantinedMain = entries.filter((f) => f.startsWith('corrupt.db.corrupt-'));
    expect(quarantinedMain.length).toBe(1);
    // Sibling WAL/SHM were also quarantined (rename path; unlink fallback is
    // acceptable, but here rename succeeds on same tmpdir).
    const quarantinedWal = entries.filter((f) => f.startsWith('corrupt.db-wal.corrupt-'));
    expect(quarantinedWal.length).toBe(1);

    // The fresh DB is functional: insert + keyword search return a hit.
    recovered!.upsertChunk({
      id: 'a.md:0',
      path: 'a.md',
      content: 'diabetes management tips',
      embedding: [1, 0, 0],
      startLine: 1,
      endLine: 1,
    });
    const results = recovered!.keywordSearch('diabetes', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('a.md');

    // Corruption was logged loudly — sanitized (no PHI markers from garbage).
    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('CORRUPTION');
    expect(logged).not.toContain('glucose');
    expect(logged).not.toContain('chest pain');

    recovered!.close();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('does not trigger recovery for a fresh (non-corrupt) DB', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const dbPath = path.join(tmpDir, 'fresh.db');
    const s = new SqliteStore(dbPath, 'default');
    const entries = fs.readdirSync(tmpDir);
    expect(entries.filter((f) => f.includes('.corrupt-'))).toHaveLength(0);
    s.close();
    errorSpy.mockRestore();
  });
});
