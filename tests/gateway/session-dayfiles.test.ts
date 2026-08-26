import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../src/gateway/session';

// P2b Wave D-1 / D1.2 — recordTurn also writes the append-only day-file archive
// (<sessionsPath>/YYYY-MM-DD.jsonl, or <sessionsPath>/<chatId>/YYYY-MM-DD.jsonl in per-chat / no-registry
// mode). Transitional DUAL-WRITE: the legacy active file + in-memory history stay intact (the read-path
// switch is D1.5, active-write removal is D1.6). This step adds the day-file write + midnight rollover.

describe('session day-file archive (D1.2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-day-'));
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const nonEmptyLines = (p: string): string[] =>
    fs.readFileSync(p, 'utf-8').split('\n').filter((l) => l.length > 0);

  it("recordTurn appends the turn to today's day file (flat/registry mode)", async () => {
    jest.setSystemTime(new Date('2026-08-26T10:00:00.000Z'));
    const m = new SessionManager({ sessionsPath: dir });
    await m.recordTurn('c1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
    const dayFile = path.join(dir, '2026-08-26.jsonl');
    expect(fs.existsSync(dayFile)).toBe(true);
    expect(nonEmptyLines(dayFile).length).toBe(2);
  });

  it('a turn recorded after midnight lands in the NEW day file (rollover)', async () => {
    const m = new SessionManager({ sessionsPath: dir });
    jest.setSystemTime(new Date('2026-08-26T23:59:00.000Z'));
    await m.recordTurn('c1', [{ role: 'user', content: 'late' }]);
    jest.setSystemTime(new Date('2026-08-27T00:01:00.000Z'));
    await m.recordTurn('c1', [{ role: 'user', content: 'early' }]);
    expect(nonEmptyLines(path.join(dir, '2026-08-26.jsonl')).length).toBe(1);
    expect(nonEmptyLines(path.join(dir, '2026-08-27.jsonl')).length).toBe(1);
  });

  it('per-chat mode namespaces day files under <chatId>/', async () => {
    jest.setSystemTime(new Date('2026-08-26T10:00:00.000Z'));
    const m = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    await m.recordTurn('cx', [{ role: 'user', content: 'hi' }]);
    expect(fs.existsSync(path.join(dir, 'cx', '2026-08-26.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '2026-08-26.jsonl'))).toBe(false);
  });

  it('day files are written 0600', async () => {
    jest.setSystemTime(new Date('2026-08-26T10:00:00.000Z'));
    const m = new SessionManager({ sessionsPath: dir });
    await m.recordTurn('c1', [{ role: 'user', content: 'hi' }]);
    const mode = fs.statSync(path.join(dir, '2026-08-26.jsonl')).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('D1.6: recordTurn no longer writes the legacy active file (dual-write ended)', async () => {
    jest.setSystemTime(new Date('2026-08-26T10:00:00.000Z'));
    const m = new SessionManager({ sessionsPath: dir });
    await m.recordTurn('c1', [{ role: 'user', content: 'hi' }]);
    expect(fs.existsSync(path.join(dir, 'active-c1.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '2026-08-26.jsonl'))).toBe(true);
  });

  it('DD8: day files are never size-rotated (append-only; anchors stay stable)', async () => {
    jest.setSystemTime(new Date('2026-08-26T10:00:00.000Z'));
    // A tiny rotation threshold would have rotated the old active file; day files must ignore it.
    const m = new SessionManager({ sessionsPath: dir, rotationConfig: { maxSizeBytes: 1, maxArchived: 3 } });
    for (let i = 0; i < 5; i++) {
      await m.recordTurn('c1', [{ role: 'user', content: 'x'.repeat(500) }]);
    }
    const dayFile = path.join(dir, '2026-08-26.jsonl');
    expect(nonEmptyLines(dayFile).length).toBe(5); // all 5 lines in ONE unrotated file
    expect(fs.existsSync(dayFile + '.1.gz')).toBe(false); // no rotation artifact
  });
});
