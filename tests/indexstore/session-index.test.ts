import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SqliteSessionIndex } from '../../src/indexstore';

const tmpDirs: string[] = [];

function tmp(): { dir: string; dbPath: string; sessionsDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sessidx-'));
  tmpDirs.push(dir);
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  return { dir, dbPath: path.join(dir, 'search.db'), sessionsDir };
}

// A day-file JSONL line matches SessionManager.serializeEntry: {timestamp, role, content, chatId}.
function entry(role: string, content: string | null, ts: string): string {
  return JSON.stringify({ timestamp: ts, role, content, chatId: 'chat1' });
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('SqliteSessionIndex', () => {
  test('indexes turns and returns an exact-word match with its {file,line} anchor', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });

    idx.indexTurn('2026-08-27.jsonl', 1, 'user', '2026-08-27T10:00:00.000Z', 'my knee hurts today');
    idx.indexTurn('2026-08-27.jsonl', 2, 'assistant', '2026-08-27T10:00:01.000Z', 'noted, resting helps');
    idx.indexTurn('2026-08-27.jsonl', 3, 'user', '2026-08-27T10:01:00.000Z', 'started metformin this week');

    const res = idx.search('metformin');
    idx.close();

    expect(res.status).toBe('full');
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({
      file: '2026-08-27.jsonl',
      line: 3,
      role: 'user',
      snippet: 'started metformin this week',
    });
  });

  test('PLAT-20: an exact clinical phrase is returned verbatim and every token matches', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.indexTurn('2026-06-01.jsonl', 7, 'user', '2026-06-01T09:00:00.000Z', 'metformin 500mg twice daily');

    const phrase = idx.search('metformin 500mg twice daily');
    expect(phrase.hits).toHaveLength(1);
    expect(phrase.hits[0].snippet).toBe('metformin 500mg twice daily');
    expect(phrase.hits[0].line).toBe(7);

    // Each keyword token also matches on its own (FTS tokenization keeps 500mg one token).
    for (const token of ['metformin', '500mg', 'twice', 'daily']) {
      expect(idx.search(token).hits).toHaveLength(1);
    }
    idx.close();
  });

  test('orders results by recency, newest first', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.indexTurn('2026-01-01.jsonl', 1, 'user', '2026-01-01T00:00:00.000Z', 'aspirin dose was low');
    idx.indexTurn('2026-05-01.jsonl', 1, 'user', '2026-05-01T00:00:00.000Z', 'aspirin dose increased');

    const res = idx.search('aspirin');
    idx.close();

    expect(res.hits.map(h => h.ts)).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  test('a query with no tokens returns an empty full result, never an error', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.indexTurn('2026-08-27.jsonl', 1, 'user', '2026-08-27T10:00:00.000Z', 'hello');
    const res = idx.search('   !!!   ');
    idx.close();
    expect(res).toEqual({ hits: [], status: 'full' });
  });

  test('a DB error yields status:failed with no hits, never throws', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.indexTurn('2026-08-27.jsonl', 1, 'user', '2026-08-27T10:00:00.000Z', 'hello');
    idx.close(); // subsequent queries hit a closed connection
    const res = idx.search('hello');
    expect(res).toEqual({ hits: [], status: 'failed' });
  });

  test('respects the limit option', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    for (let i = 1; i <= 5; i++) {
      idx.indexTurn('2026-08-27.jsonl', i, 'user', `2026-08-27T10:0${i}:00.000Z`, `aspirin note ${i}`);
    }
    const res = idx.search('aspirin', { limit: 2 });
    idx.close();
    expect(res.hits).toHaveLength(2);
  });

  test('indexTurn is idempotent per {file,line} — re-indexing does not duplicate', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.indexTurn('2026-08-27.jsonl', 4, 'user', '2026-08-27T10:00:00.000Z', 'ibuprofen taken');
    idx.indexTurn('2026-08-27.jsonl', 4, 'user', '2026-08-27T10:00:00.000Z', 'ibuprofen taken'); // same anchor again
    const res = idx.search('ibuprofen');
    idx.close();
    expect(res.hits).toHaveLength(1);
  });

  test('rebuilds from day files at construction when the index is empty (A-MF4)', () => {
    const { dbPath, sessionsDir } = tmp();
    fs.writeFileSync(
      path.join(sessionsDir, '2026-08-27.jsonl'),
      entry('user', 'lisinopril prescribed', '2026-08-27T10:00:00.000Z') + '\n',
    );

    const idx = new SqliteSessionIndex({ dbPath, sessionsDir }); // no explicit indexTurn / rebuild call
    const res = idx.search('lisinopril');
    const empty = idx.isEmpty();
    idx.close();

    expect(empty).toBe(false);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({ file: '2026-08-27.jsonl', line: 1, role: 'user' });
  });

  test('rebuildFromDayFiles skips malformed and empty lines but keeps physical line numbers aligned', () => {
    const { dbPath, sessionsDir } = tmp();
    // line 1 valid, line 2 malformed (occupies its slot), line 3 valid, line 4 null content (no text to index).
    fs.writeFileSync(
      path.join(sessionsDir, '2026-08-27.jsonl'),
      [
        entry('user', 'warfarin started', '2026-08-27T10:00:00.000Z'),
        '{ this is not json',
        entry('user', 'atorvastatin started', '2026-08-27T10:02:00.000Z'),
        entry('assistant', null, '2026-08-27T10:03:00.000Z'),
      ].join('\n') + '\n',
    );

    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.rebuildFromDayFiles();

    // The valid entry AFTER the malformed slot must resolve to physical line 3 (not 2) — this is the
    // anchor-alignment guarantee that keeps rebuild consistent with the incremental append path.
    const hit = idx.search('atorvastatin');
    const warfarin = idx.search('warfarin');
    idx.close();
    expect(hit.hits).toHaveLength(1);
    expect(hit.hits[0].line).toBe(3);
    // warfarin is still at line 1.
    expect(warfarin.hits[0].line).toBe(1);
  });

  test('rebuildFromDayFiles is idempotent — re-running does not double-count', () => {
    const { dbPath, sessionsDir } = tmp();
    fs.writeFileSync(
      path.join(sessionsDir, '2026-08-27.jsonl'),
      entry('user', 'clopidogrel prescribed', '2026-08-27T10:00:00.000Z') + '\n',
    );
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.rebuildFromDayFiles();
    idx.rebuildFromDayFiles();
    const res = idx.search('clopidogrel');
    idx.close();
    expect(res.hits).toHaveLength(1);
  });

  test('rebuildFromDayFiles walks per-chat subdirectories (no-registry layout)', () => {
    const { dbPath, sessionsDir } = tmp();
    const chatDir = path.join(sessionsDir, 'chatA');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir, '2026-08-27.jsonl'),
      entry('user', 'gabapentin note', '2026-08-27T10:00:00.000Z') + '\n',
    );
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    const res = idx.search('gabapentin');
    idx.close();
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].file).toBe('2026-08-27.jsonl');
  });
});
