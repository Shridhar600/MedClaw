import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LLMProvider, Message } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';

// P2b Wave D-1 / D1.5+D1.6 — resume-after-restart reads the WINDOW (session-window.json, per-chat in
// no-registry mode) + replays the day-file tail from `verbatimFrom` to EOF. It NO LONGER reads the
// legacy `active-<chatId>.jsonl` file, and since D1.6 `recordTurn` no longer WRITES one — so resume can
// only come from the day-file archive + window. The `rmActive` guard belt-and-braces that no stale
// active file (should one exist) ever influences resume. The window is a derived snapshot: summaryBlock
// + `verbatimFrom` = archive-EOF walked back by the verbatim tail length.

describe('session resume from window + day files (D1.5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-resume-'));
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeProvider = (text: string): LLMProvider => ({
    chat: jest.fn().mockResolvedValue({ type: 'text', text }),
    embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  });
  const rmActive = (chatId: string): void => fs.rmSync(path.join(dir, `active-${chatId}.jsonl`), { force: true });

  it('resumes the full verbatim history after restart — reads day files + window, NOT the active file', async () => {
    const a = new SessionManager({ sessionsPath: dir });
    for (let i = 0; i < 3; i++) {
      await a.recordTurn('c1', [
        { role: 'user', content: `u${i}` },
        { role: 'assistant', content: `a${i}` },
      ]);
    }
    const before = await a.prepareHistory('c1');
    expect(before).toHaveLength(6);

    rmActive('c1'); // the read-path must NOT depend on the legacy active file
    const b = new SessionManager({ sessionsPath: dir });
    expect(await b.prepareHistory('c1')).toEqual(before);
  });

  it('resumes summary + verbatim tail after a compaction', async () => {
    const a = new SessionManager({
      sessionsPath: dir,
      provider: makeProvider('SUMMARY of older turns'),
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 4 },
    });
    for (let i = 0; i < 6; i++) {
      await a.recordTurn('c1', [
        { role: 'user', content: `u${i}` },
        { role: 'assistant', content: `a${i}` },
      ]);
    }
    await a.runCompaction('c1');
    const before = await a.prepareHistory('c1');
    expect(before[0].role).toBe('system');
    // H4 turn-aware: keepRecentTurns=4 keeps the last 4 TURNS (8 messages), u2..a5.
    expect(before.slice(1).map((m: Message) => m.content)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']);

    rmActive('c1');
    const b = new SessionManager({ sessionsPath: dir, provider: makeProvider('UNUSED') });
    expect(await b.prepareHistory('c1')).toEqual(before);
  });

  it('resumes a tail that spans a day boundary (multi-file replay)', async () => {
    const a = new SessionManager({ sessionsPath: dir });
    jest.setSystemTime(new Date('2026-08-26T23:59:00.000Z'));
    await a.recordTurn('c1', [{ role: 'user', content: 'night' }]);
    jest.setSystemTime(new Date('2026-08-27T00:01:00.000Z'));
    await a.recordTurn('c1', [{ role: 'user', content: 'morning' }]);

    rmActive('c1');
    const b = new SessionManager({ sessionsPath: dir });
    expect((await b.prepareHistory('c1')).map((m: Message) => m.content)).toEqual(['night', 'morning']);
  });

  it('no-registry mode resumes per-chat windows independently', async () => {
    const a = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    await a.recordTurn('cx', [
      { role: 'user', content: 'x1' },
      { role: 'assistant', content: 'x2' },
    ]);
    await a.recordTurn('cy', [{ role: 'user', content: 'y1' }]);

    rmActive('cx');
    rmActive('cy');
    const b = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    expect((await b.prepareHistory('cx')).map((m: Message) => m.content)).toEqual(['x1', 'x2']);
    expect((await b.prepareHistory('cy')).map((m: Message) => m.content)).toEqual(['y1']);
  });

  it('per-chat mode: one chat\'s compaction summary never leaks to another chat on resume (X-2)', async () => {
    const a = new SessionManager({
      sessionsPath: dir,
      perChatArchive: true,
      provider: makeProvider('SUMMARY of chat A — glucose 300 recorded'),
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
    });
    for (let i = 0; i < 6; i++) {
      await a.recordTurn('chatA', [
        { role: 'user', content: `a-u${i}` },
        { role: 'assistant', content: `a-a${i}` },
      ]);
    }
    await a.runCompaction('chatA'); // chatA now has a summary window mentioning glucose 300
    await a.recordTurn('chatB', [
      { role: 'user', content: 'chatB hello' },
      { role: 'assistant', content: 'chatB hi' },
    ]);

    rmActive('chatA');
    rmActive('chatB');
    const b = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    const chatB = await b.prepareHistory('chatB');
    // chatB resumes ONLY its own turns — never chatA's summary/PHI.
    expect(chatB.some((m: Message) => typeof m.content === 'string' && m.content.includes('glucose 300'))).toBe(false);
    expect(chatB.some((m: Message) => typeof m.content === 'string' && m.content.includes('Previous conversation summary'))).toBe(false);
    expect(chatB.map((m: Message) => m.content)).toEqual(['chatB hello', 'chatB hi']);
  });

  it('a wiped window resumes empty at EOF, archive preserved (A-L6)', async () => {
    const a = new SessionManager({ sessionsPath: dir });
    await a.recordTurn('c1', [{ role: 'user', content: 'kept on disk' }]);
    fs.rmSync(path.join(dir, 'session-window.json')); // lose the window; day file stays

    const b = new SessionManager({ sessionsPath: dir });
    expect(await b.prepareHistory('c1')).toEqual([]); // fresh window at EOF — no in-context tail
    expect(fs.existsSync(path.join(dir, '2026-08-26.jsonl'))).toBe(true); // archive intact
  });
});
