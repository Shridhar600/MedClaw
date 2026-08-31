import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../src/gateway/session';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-daylines-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('SessionManager.readDayFileLines (D4.4 sweep seam)', () => {
  it("returns today's raw JSONL lines across all chats", async () => {
    const sm = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    await sm.recordTurn('chatA', [{ role: 'user', content: 'took naproxen' }]);
    await sm.recordTurn('chatB', [{ role: 'user', content: 'bad headache' }]);

    const today = sm.readDayFileLines(new Date());
    expect(today.length).toBe(2);
    expect(today.some(l => l.includes('naproxen'))).toBe(true);
    expect(today.some(l => l.includes('headache'))).toBe(true);
    // every returned line is a raw, parseable archive line
    for (const l of today) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('returns [] for a day with no day file (no throw)', async () => {
    const sm = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    await sm.recordTurn('chatA', [{ role: 'user', content: 'hello' }]);
    expect(sm.readDayFileLines(new Date('2000-01-01T00:00:00.000Z'))).toEqual([]);
  });

  it('stamps origin on a heartbeat turn and omits it for a chat turn (A-H1)', async () => {
    const sm = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    await sm.recordTurn('c1', [{ role: 'user', content: 'chat turn' }]);             // default 'chat'
    await sm.recordTurn('c1', [{ role: 'user', content: 'hb turn' }], 'heartbeat');  // daemon-authored
    const entries = sm.readDayFileLines(new Date()).map(l => JSON.parse(l));
    expect(entries.find(e => e.content === 'chat turn').origin).toBeUndefined(); // byte-stable default
    expect(entries.find(e => e.content === 'hb turn').origin).toBe('heartbeat');
  });

  it('does NOT follow a symlinked day file (no cross-profile read)', () => {
    const sm = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-other-'));
    const otherFile = path.join(otherDir, 'secret.jsonl');
    fs.writeFileSync(otherFile, JSON.stringify({ role: 'user', content: 'other profile ibuprofen', chatId: 'x' }) + '\n');
    const day = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    fs.mkdirSync(path.join(dir, 'chatS'), { recursive: true });
    fs.symlinkSync(otherFile, path.join(dir, 'chatS', day));

    const lines = sm.readDayFileLines(new Date());
    expect(lines.join('\n')).not.toContain('other profile ibuprofen'); // symlink not followed
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it('reads chat subdirectories in deterministic (sorted) order', async () => {
    const sm = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    await sm.recordTurn('chatB', [{ role: 'user', content: 'from B' }]);
    await sm.recordTurn('chatA', [{ role: 'user', content: 'from A' }]);
    const lines = sm.readDayFileLines(new Date()).map(l => JSON.parse(l).content);
    expect(lines).toEqual(['from A', 'from B']); // sorted by chat-dir name, not filesystem enumeration
  });

  it('ignores blank lines and non-day-file entries in the sessions dir', async () => {
    const sm = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    await sm.recordTurn('chatA', [{ role: 'user', content: 'metformin' }]);
    // a stray window file at the top level must never be read as a day file
    fs.writeFileSync(path.join(dir, 'session-window.chatA.json'), '{"summaryBlock":""}');

    const today = sm.readDayFileLines(new Date());
    expect(today.length).toBe(1);
    expect(today[0]).toContain('metformin');
  });
});
