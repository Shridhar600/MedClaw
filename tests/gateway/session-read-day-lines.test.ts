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
