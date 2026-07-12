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

  it('existing vec_meta table still present and unchanged', () => {
    const cols = getTableInfo('vec_meta');
    const colDefs = cols.map(c => ({ name: c.name, type: c.type.toUpperCase() }));
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

  it('existing chunks_fts virtual table present', () => {
    const cols = getTableInfo('chunks_fts');
    expect(cols.length).toBeGreaterThan(0);
  });

  it('existing file_hashes table still present', () => {
    const cols = getTableInfo('file_hashes');
    const colNames = cols.map(c => c.name).sort();
    expect(colNames).toEqual(['embedding_model', 'hash', 'indexed_at', 'path']);
  });
});
