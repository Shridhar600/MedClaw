import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../src/gateway/session';
import { SqliteSessionIndex } from '../../src/indexstore/session-index';
import { sweep } from '../../src/memcore/transcript-sweep';

const fsReal = jest.requireActual<typeof import('fs')>('fs');

// P2b Wave D-1 / D1.6 — one-time migration of legacy `active-<chatId>.jsonl` files into the append-only
// day-file archive, sentinel-gated by `<sessionsPath>/.migrated`. Each day file is built ATOMICALLY and
// WRITE-IF-ABSENT (A-MF2/N-1) — never a blind overwrite — so a retry after a crash (or after live turns
// appended to today's day file) can never destroy live-recorded data. Registry mode pools all sources
// into shared root day files; no-registry mode buckets each source into its own `<chatId>/` subdir.

describe('legacy session migration (D1.6)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-migrate-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  type E = { ts: string; role: string; content: string; chatId?: string };
  const writeActive = (chatId: string, entries: E[]): void => {
    const lines = entries.map((e) =>
      JSON.stringify({ timestamp: e.ts, role: e.role, content: e.content, chatId: e.chatId ?? chatId }));
    fs.writeFileSync(path.join(dir, `active-${chatId}.jsonl`), lines.join('\n') + '\n');
  };
  const nonEmpty = (p: string): string[] =>
    fs.readFileSync(p, 'utf-8').split('\n').filter((l) => l.length > 0);

  it('migrates a legacy active file spanning 3 dates into 3 day files, timestamp-ordered', () => {
    writeActive('c1', [
      { ts: '2026-08-26T10:00:00.000Z', role: 'user', content: 'c-late' },
      { ts: '2026-08-24T10:00:00.000Z', role: 'user', content: 'a-first' },
      { ts: '2026-08-24T11:00:00.000Z', role: 'assistant', content: 'a-second' },
      { ts: '2026-08-25T10:00:00.000Z', role: 'user', content: 'b-mid' },
    ]);

    new SessionManager({ sessionsPath: dir });

    expect(fs.existsSync(path.join(dir, '.migrated'))).toBe(true);
    expect(nonEmpty(path.join(dir, '2026-08-24.jsonl')).map((l) => JSON.parse(l).content)).toEqual(['a-first', 'a-second']);
    expect(nonEmpty(path.join(dir, '2026-08-25.jsonl')).map((l) => JSON.parse(l).content)).toEqual(['b-mid']);
    expect(nonEmpty(path.join(dir, '2026-08-26.jsonl')).map((l) => JSON.parse(l).content)).toEqual(['c-late']);
  });

  it('is idempotent — a second construction over the same dir does not change the day files', () => {
    writeActive('c1', [{ ts: '2026-08-26T10:00:00.000Z', role: 'user', content: 'x' }]);
    new SessionManager({ sessionsPath: dir });
    const before = fs.readFileSync(path.join(dir, '2026-08-26.jsonl'), 'utf-8');
    new SessionManager({ sessionsPath: dir });
    expect(fs.readFileSync(path.join(dir, '2026-08-26.jsonl'), 'utf-8')).toBe(before);
  });

  it('write-if-absent preserves live-appended lines on a retry (N-1 data-loss guard)', async () => {
    writeActive('c1', [{ ts: '2026-08-26T10:00:00.000Z', role: 'user', content: 'migrated' }]);
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    const a = new SessionManager({ sessionsPath: dir });
    await a.recordTurn('c1', [{ role: 'assistant', content: 'live turn after migration' }]);
    jest.useRealTimers();

    // Simulate a retry: the sentinel is gone but today's day file already carries the live append.
    fs.rmSync(path.join(dir, '.migrated'));
    new SessionManager({ sessionsPath: dir });

    const contents = nonEmpty(path.join(dir, '2026-08-26.jsonl')).map((l) => JSON.parse(l).content);
    expect(contents).toEqual(['migrated', 'live turn after migration']); // BOTH survive; no overwrite
  });

  it('MERGES legacy rows into a day file a live append created BEFORE migration completed (F-3 data-loss)', () => {
    // A prior migration attempt failed (sentinel absent) but a live turn was recorded to today's day
    // file first. The legacy active file still holds rows for that SAME day. A blind write-if-absent
    // would skip the whole day and LOSE the legacy rows; migration must merge them in.
    writeActive('c1', [{ ts: '2026-08-26T09:00:00.000Z', role: 'user', content: 'legacy row' }]);
    const dayDir = path.join(dir, 'c1');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
      path.join(dayDir, '2026-08-26.jsonl'),
      JSON.stringify({ timestamp: '2026-08-26T12:00:00.000Z', role: 'assistant', content: 'live append', chatId: 'c1' }) + '\n',
    );

    new SessionManager({ sessionsPath: dir, perChatArchive: true });

    const contents = nonEmpty(path.join(dayDir, '2026-08-26.jsonl')).map((l) => JSON.parse(l).content);
    expect(contents).toContain('legacy row');   // must NOT be lost
    expect(contents).toContain('live append');  // must be preserved
    expect(contents).toEqual(['live append', 'legacy row']); // append-only merge preserves the live anchor
  });

  it('is idempotent through the merge path — a live-collision day file is byte-stable on re-run', () => {
    writeActive('c1', [{ ts: '2026-08-26T09:00:00.000Z', role: 'user', content: 'legacy row' }]);
    const dayDir = path.join(dir, 'c1');
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
      path.join(dayDir, '2026-08-26.jsonl'),
      JSON.stringify({ timestamp: '2026-08-26T12:00:00.000Z', role: 'assistant', content: 'live append', chatId: 'c1' }) + '\n',
    );
    new SessionManager({ sessionsPath: dir, perChatArchive: true });
    const after1 = fs.readFileSync(path.join(dayDir, '2026-08-26.jsonl'), 'utf-8');
    // remove the sentinel to force the migration to run again over the merged file
    fs.rmSync(path.join(dir, '.migrated'));
    new SessionManager({ sessionsPath: dir, perChatArchive: true });
    expect(fs.readFileSync(path.join(dayDir, '2026-08-26.jsonl'), 'utf-8')).toBe(after1);
  });

  it('failed migration retry preserves an open anchor and reconciles the session index', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    let index: SqliteSessionIndex | undefined;
    try {
      writeActive('c1', [{ ts: '2026-08-26T09:00:00.000Z', role: 'user', content: 'legacy-anchor' }]);

      const writeSpy = jest.spyOn(fsReal, 'writeFileSync').mockImplementation(() => {
        throw new Error('injected migration write failure');
      });
      const first = new SessionManager({ sessionsPath: dir, perChatArchive: true });
      writeSpy.mockRestore();

      await first.recordTurn('c1', [{ role: 'user', content: 'live-anchor' }]);
      index = new SqliteSessionIndex({ dbPath: path.join(dir, 'search.db'), sessionsDir: dir });
      const beforeRetry = index.search('live-anchor', { chatId: 'c1' });
      expect(beforeRetry.hits).toHaveLength(1);
      expect(beforeRetry.hits[0]).toMatchObject({ file: '2026-08-26.jsonl', line: 1, snippet: 'live-anchor' });

      const retry = new SessionManager({ sessionsPath: dir, perChatArchive: true });
      retry.setTurnIndex(index);

      const dayFile = path.join(dir, 'c1', '2026-08-26.jsonl');
      expect(nonEmpty(dayFile).map((line) => JSON.parse(line).content)).toEqual(['live-anchor', 'legacy-anchor']);
      expect(index.search('live-anchor', { chatId: 'c1' }).hits[0]).toMatchObject({ line: beforeRetry.hits[0].line, snippet: 'live-anchor' });
      expect(index.search('legacy-anchor', { chatId: 'c1' }).hits).toEqual([
        expect.objectContaining({ file: '2026-08-26.jsonl', line: 2, snippet: 'legacy-anchor' }),
      ]);
    } finally {
      index?.close();
      jest.useRealTimers();
    }
  });

  it('persists chat origin so a marker-prefixed chat is swept while a heartbeat is excluded', async () => {
    const manager = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    await manager.recordTurn('c1', [{ role: 'user', content: '[Heartbeat Trigger]\ntook naproxen' }]);
    await manager.recordTurn('c1', [{ role: 'user', content: '[Heartbeat Trigger]\ntook metformin' }], 'heartbeat');

    const dayFile = path.join(dir, 'c1', fs.readdirSync(path.join(dir, 'c1')).find((name) => name.endsWith('.jsonl'))!);
    const lines = nonEmpty(dayFile);
    expect(lines.map((line) => JSON.parse(line).origin)).toEqual(['chat', 'heartbeat']);
    expect(sweep({
      dayFileLines: lines,
      ledgerEntitiesForDay: new Set(),
      existingCuriosity: [],
      lexicon: { med: ['naproxen', 'metformin'], symptom: [], appointment: [] },
    }).items.map((item) => item.relatedEntity)).toEqual(['naproxen']);
  });

  it('no-registry mode buckets each source file into its own <chatId>/ subdir', () => {
    writeActive('cx', [{ ts: '2026-08-26T10:00:00.000Z', role: 'user', content: 'x1' }]);
    writeActive('cy', [{ ts: '2026-08-26T10:00:00.000Z', role: 'user', content: 'y1' }]);

    new SessionManager({ sessionsPath: dir, perChatArchive: true });

    expect(nonEmpty(path.join(dir, 'cx', '2026-08-26.jsonl')).map((l) => JSON.parse(l).content)).toEqual(['x1']);
    expect(nonEmpty(path.join(dir, 'cy', '2026-08-26.jsonl')).map((l) => JSON.parse(l).content)).toEqual(['y1']);
    expect(fs.existsSync(path.join(dir, '2026-08-26.jsonl'))).toBe(false); // never interleaved at root
  });

  it('skips a malformed line without crashing', () => {
    fs.writeFileSync(
      path.join(dir, 'active-c1.jsonl'),
      [
        JSON.stringify({ timestamp: '2026-08-26T10:00:00.000Z', role: 'user', content: 'good', chatId: 'c1' }),
        'this is not json',
        JSON.stringify({ timestamp: '2026-08-26T11:00:00.000Z', role: 'assistant', content: 'good2', chatId: 'c1' }),
      ].join('\n') + '\n',
    );

    expect(() => new SessionManager({ sessionsPath: dir })).not.toThrow();
    expect(nonEmpty(path.join(dir, '2026-08-26.jsonl')).map((l) => JSON.parse(l).content)).toEqual(['good', 'good2']);
  });

  it('seeds the window to the last keepRecentTurns so resume shows the tail', async () => {
    writeActive('c1', [
      { ts: '2026-08-26T10:00:00.000Z', role: 'user', content: 'm0' },
      { ts: '2026-08-26T10:01:00.000Z', role: 'assistant', content: 'm1' },
      { ts: '2026-08-26T10:02:00.000Z', role: 'user', content: 'm2' },
      { ts: '2026-08-26T10:03:00.000Z', role: 'assistant', content: 'm3' },
    ]);

    const m = new SessionManager({
      sessionsPath: dir,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
    });
    // The archive holds all 4; the seeded window points at the last 2, so the in-context history is the tail.
    expect((await m.prepareHistory('c1')).map((x) => x.content)).toEqual(['m2', 'm3']);
    expect(nonEmpty(path.join(dir, '2026-08-26.jsonl'))).toHaveLength(4);
  });
});
