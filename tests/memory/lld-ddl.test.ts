import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteStore } from '../../src/memory/sqlite-store';

describe('LLD §4 DDL addendum tables', () => {
  let tmpDir: string;
  let store: SqliteStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-lld-ddl-'));
    store = new SqliteStore(path.join(tmpDir, 'test.db'));
    store.ensureVecTable(4);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  function getTableInfo(table: string): Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }> {
    return store.db.prepare(`PRAGMA table_info(${table})`).all() as any;
  }

  it('meta table exists with exact LLD column set', () => {
    const cols = getTableInfo('meta');
    const colDefs = cols.map(c => ({ name: c.name, type: c.type.toUpperCase(), pk: c.pk }));
    expect(colDefs).toEqual([
      { name: 'key', type: 'TEXT', pk: 1 },
      { name: 'value', type: 'TEXT', pk: 0 },
    ]);
  });

  it('chunk_stats table exists with exact LLD column set', () => {
    const cols = getTableInfo('chunk_stats');
    const colDefs = cols.map(c => ({
      name: c.name,
      type: c.type.toUpperCase(),
      pk: c.pk,
      dflt_value: c.dflt_value,
    }));
    expect(colDefs).toEqual([
      { name: 'chunk_id', type: 'TEXT', pk: 1, dflt_value: null },
      { name: 'injected_count', type: 'INTEGER', pk: 0, dflt_value: '0' },
      { name: 'used_count', type: 'INTEGER', pk: 0, dflt_value: '0' },
      { name: 'last_used_at', type: 'TEXT', pk: 0, dflt_value: null },
    ]);
  });

  it('events table exists with exact LLD column set', () => {
    const cols = getTableInfo('events');
    const colDefs = cols.map(c => ({ name: c.name, type: c.type.toUpperCase(), pk: c.pk }));
    expect(colDefs).toEqual([
      { name: 'id', type: 'TEXT', pk: 1 },
      { name: 'event_type', type: 'TEXT', pk: 0 },
      { name: 'entity', type: 'TEXT', pk: 0 },
      { name: 'value', type: 'TEXT', pk: 0 },
      { name: 'ts', type: 'TEXT', pk: 0 },
    ]);
  });

  it('vec_meta table has been consolidated away — meta is the sole kv store', () => {
    const vecMetaCols = getTableInfo('vec_meta');
    expect(vecMetaCols).toEqual([]);

    const metaCols = getTableInfo('meta');
    const colDefs = metaCols.map(c => ({ name: c.name, type: c.type.toUpperCase() }));
    expect(colDefs).toEqual([
      { name: 'key', type: 'TEXT' },
      { name: 'value', type: 'TEXT' },
    ]);
  });

  it('existing chunks table still present', () => {
    const cols = getTableInfo('chunks');
    const colNames = cols.map(c => c.name).sort();
    expect(colNames).toEqual(['content', 'embedding', 'end_line', 'id', 'path', 'start_line']);
  });

  it('chunks_fts indexes chunk content and is queryable via MATCH', () => {
    store.upsertChunk({
      id: 'fts-chunk:0',
      path: 'fts-test.md',
      content: 'The quick brown fox jumps over the lazy zorbnaxx',
      startLine: 1,
      endLine: 1,
    });

    const matches = store.db.prepare(
      'SELECT id, path FROM chunks_fts WHERE chunks_fts MATCH ?',
    ).all('zorbnaxx') as Array<{ id: string; path: string }>;

    expect(matches).toEqual([{ id: 'fts-chunk:0', path: 'fts-test.md' }]);

    const noMatches = store.db.prepare(
      'SELECT id FROM chunks_fts WHERE chunks_fts MATCH ?',
    ).all('nonexistentterm12345') as Array<{ id: string }>;
    expect(noMatches).toEqual([]);
  });

  it('existing file_hashes table still present', () => {
    const cols = getTableInfo('file_hashes');
    const colNames = cols.map(c => c.name).sort();
    expect(colNames).toEqual(['embedding_model', 'hash', 'indexed_at', 'path']);
  });
});
