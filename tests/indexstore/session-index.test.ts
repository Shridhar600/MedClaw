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

    idx.indexTurn('chat1', '2026-08-27.jsonl', 1, 'user', '2026-08-27T10:00:00.000Z', 'my knee hurts today');
    idx.indexTurn('chat1', '2026-08-27.jsonl', 2, 'assistant', '2026-08-27T10:00:01.000Z', 'noted, resting helps');
    idx.indexTurn('chat1', '2026-08-27.jsonl', 3, 'user', '2026-08-27T10:01:00.000Z', 'started metformin this week');

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
    idx.indexTurn('chat1', '2026-06-01.jsonl', 7, 'user', '2026-06-01T09:00:00.000Z', 'metformin 500mg twice daily');

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
    idx.indexTurn('chat1', '2026-01-01.jsonl', 1, 'user', '2026-01-01T00:00:00.000Z', 'aspirin dose was low');
    idx.indexTurn('chat1', '2026-05-01.jsonl', 1, 'user', '2026-05-01T00:00:00.000Z', 'aspirin dose increased');

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
    idx.indexTurn('chat1', '2026-08-27.jsonl', 1, 'user', '2026-08-27T10:00:00.000Z', 'hello');
    const res = idx.search('   !!!   ');
    idx.close();
    expect(res).toEqual({ hits: [], status: 'full' });
  });

  test('a DB error yields status:failed with no hits, never throws', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.indexTurn('chat1', '2026-08-27.jsonl', 1, 'user', '2026-08-27T10:00:00.000Z', 'hello');
    idx.close(); // subsequent queries hit a closed connection
    const res = idx.search('hello');
    expect(res).toEqual({ hits: [], status: 'failed' });
  });

  test('respects the limit option', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    for (let i = 1; i <= 5; i++) {
      idx.indexTurn('chat1', '2026-08-27.jsonl', i, 'user', `2026-08-27T10:0${i}:00.000Z`, `aspirin note ${i}`);
    }
    const res = idx.search('aspirin', { limit: 2 });
    idx.close();
    expect(res.hits).toHaveLength(2);
  });

  test('indexTurn is idempotent per {file,line} — re-indexing does not duplicate', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.indexTurn('chat1', '2026-08-27.jsonl', 4, 'user', '2026-08-27T10:00:00.000Z', 'ibuprofen taken');
    idx.indexTurn('chat1', '2026-08-27.jsonl', 4, 'user', '2026-08-27T10:00:00.000Z', 'ibuprofen taken'); // same anchor again
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

  // X-1: two chats sharing a day-file basename + line number must NOT collide, and a scoped search must
  // never surface another chat's health content.
  test('two chats with the same {file,line} do not collide and search is chat-scoped (X-1)', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    const ts = '2026-08-27T10:00:00.000Z';
    idx.indexTurn('chatA', '2026-08-27.jsonl', 1, 'user', ts, 'alpha unique clinical marker');
    idx.indexTurn('chatB', '2026-08-27.jsonl', 1, 'user', ts, 'beta unique clinical marker');

    const a = idx.search('alpha', { chatId: 'chatA' });
    const b = idx.search('beta', { chatId: 'chatB' });
    const crossFromA = idx.search('beta', { chatId: 'chatA' }); // chatA must NOT see chatB's turn
    idx.close();

    expect(a.hits).toHaveLength(1);
    expect(a.hits[0].snippet).toBe('alpha unique clinical marker');
    expect(b.hits).toHaveLength(1);
    expect(b.hits[0].snippet).toBe('beta unique clinical marker');
    expect(crossFromA.hits).toHaveLength(0); // scoped — no cross-chat disclosure
  });

  // H10: search.db and its WAL sidecars must be 0600 (they hold verbatim PHI), hardened by the adapter
  // itself — not merely by whatever opened the file first.
  test('hardens search.db and its WAL sidecars to 0600 (H10)', () => {
    const { dbPath, sessionsDir } = tmp();
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    idx.indexTurn('chat1', '2026-08-27.jsonl', 1, 'user', '2026-08-27T10:00:00.000Z', 'metoprolol note');
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(f)) {
        expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      }
    }
    idx.close();
  });

  // H8: a dropped derived FTS table (corruption) must be reset + rebuilt from the archive on the next
  // search, never silently return healthy-looking empty results.
  test('a dropped FTS table self-heals from the archive on the next search (H8)', () => {
    const { dbPath, sessionsDir } = tmp();
    fs.writeFileSync(
      path.join(sessionsDir, '2026-08-27.jsonl'),
      entry('user', 'tramadol prescribed', '2026-08-27T10:00:00.000Z') + '\n',
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
    expect(idx.search('tramadol', { chatId: 'chat1' }).hits).toHaveLength(1);

    // Simulate corruption: drop the derived FTS table out from under the open connection.
    (idx as unknown as { db: { exec(sql: string): void } }).db.exec('DROP TABLE session_turns_fts');

    const healed = idx.search('tramadol', { chatId: 'chat1' });
    idx.close();
    warn.mockRestore();
    expect(healed.status).toBe('full');
    expect(healed.hits).toHaveLength(1); // reset + rebuilt, not a silent empty result
  });

  // H5: a swallowed incremental-index failure durably marks the index dirty, so the NEXT construction
  // rebuilds from the archive and closes the hole even though the db is non-empty.
  test('a durable dirty marker forces a boot rebuild even when the index is non-empty (H5)', () => {
    const { dir, dbPath, sessionsDir } = tmp();
    // First index: only line 1 landed (line 2's write was "lost"); mark dirty durably, then close.
    const idx1 = new SqliteSessionIndex({ dbPath }); // no sessionsDir ⇒ no boot rebuild
    idx1.indexTurn('chat1', '2026-08-27.jsonl', 1, 'user', '2026-08-27T10:00:00.000Z', 'omeprazole daily');
    idx1.markDirty();
    idx1.close();
    expect(fs.existsSync(path.join(dir, 'search.db.session-dirty'))).toBe(true);

    // The archive on disk has BOTH lines (line 2 was written to the day file but never indexed).
    fs.writeFileSync(
      path.join(sessionsDir, '2026-08-27.jsonl'),
      entry('user', 'omeprazole daily', '2026-08-27T10:00:00.000Z') + '\n' +
        entry('user', 'simvastatin nightly', '2026-08-27T10:01:00.000Z') + '\n',
    );

    // Fresh index over the same (non-empty) db + archive: the dirty marker forces a rebuild that fills the hole.
    const idx2 = new SqliteSessionIndex({ dbPath, sessionsDir });
    const res = idx2.search('simvastatin', { chatId: 'chat1' });
    const cleared = fs.existsSync(path.join(dir, 'search.db.session-dirty'));
    idx2.close();
    expect(res.hits).toHaveLength(1);
    expect(cleared).toBe(false); // the marker is cleared after a successful reconcile
  });
});
