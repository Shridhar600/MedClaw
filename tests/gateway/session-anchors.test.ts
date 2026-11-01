import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from '../../src/gateway/session';
import { makeTestTemp } from '../helpers/test-temp';

describe('session day-file anchors', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTestTemp('sm-anchor-');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T10:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const nonEmptyLines = (p: string): string[] =>
    fs.readFileSync(p, 'utf-8').split('\n').filter((l) => l.length > 0);

  it('recordTurn returns one {file,line} anchor per message, resolving to the right JSONL line', async () => {
    const m = new SessionManager({ sessionsPath: dir });
    const anchors = await m.recordTurn('c1', [
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'beta' },
      { role: 'user', content: 'gamma' },
    ]);
    expect(anchors).toEqual([
      { file: '2026-08-26.jsonl', line: 1 },
      { file: '2026-08-26.jsonl', line: 2 },
      { file: '2026-08-26.jsonl', line: 3 },
    ]);
    const lines = nonEmptyLines(path.join(dir, '2026-08-26.jsonl'));
    for (const [i, expected] of ['alpha', 'beta', 'gamma'].entries()) {
      const entry = JSON.parse(lines[anchors[i].line - 1]);
      expect(entry.content).toBe(expected);
    }
  });

  it('the recorded line count equals wc -l of the day file after N appends', async () => {
    const m = new SessionManager({ sessionsPath: dir });
    await m.recordTurn('c1', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    await m.recordTurn('c1', [
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ]);
    const dayFile = path.join(dir, '2026-08-26.jsonl');
    expect(nonEmptyLines(dayFile).length).toBe(5);
    const next = await m.recordTurn('c1', [{ role: 'assistant', content: 'f' }]);
    expect(next).toEqual([{ file: '2026-08-26.jsonl', line: 6 }]);
  });

  it('anchors continue from the on-disk count after a restart (re-derived from disk)', async () => {
    const first = new SessionManager({ sessionsPath: dir });
    await first.recordTurn('c1', [
      { role: 'user', content: 'x1' },
      { role: 'assistant', content: 'x2' },
      { role: 'user', content: 'x3' },
    ]);

    const second = new SessionManager({ sessionsPath: dir });
    const anchors = await second.recordTurn('c1', [{ role: 'assistant', content: 'x4' }]);
    expect(anchors).toEqual([{ file: '2026-08-26.jsonl', line: 4 }]);
    expect(nonEmptyLines(path.join(dir, '2026-08-26.jsonl')).length).toBe(4);
  });

  it('per-chat mode namespaces the count per chat; anchor file stays the day-file basename', async () => {
    const m = new SessionManager({ sessionsPath: dir, perChatArchive: true });
    const ax = await m.recordTurn('cx', [
      { role: 'user', content: 'cx-1' },
      { role: 'assistant', content: 'cx-2' },
    ]);
    const ay = await m.recordTurn('cy', [{ role: 'user', content: 'cy-1' }]);
    expect(ax).toEqual([
      { file: '2026-08-26.jsonl', line: 1 },
      { file: '2026-08-26.jsonl', line: 2 },
    ]);
    expect(ay).toEqual([{ file: '2026-08-26.jsonl', line: 1 }]);
    expect(nonEmptyLines(path.join(dir, 'cx', '2026-08-26.jsonl')).length).toBe(2);
    expect(nonEmptyLines(path.join(dir, 'cy', '2026-08-26.jsonl')).length).toBe(1);
  });

  it('appending to a torn day file (no final newline) does not concatenate/lose the new turn', async () => {
    const dayFile = path.join(dir, '2026-08-26.jsonl');
    fs.writeFileSync(
      dayFile,
      JSON.stringify({ timestamp: '2026-08-26T09:00:00.000Z', role: 'user', content: 'seed turn', chatId: 'c1' }),
      { encoding: 'utf-8' },
    ); // deliberately no '\n'

    const m = new SessionManager({ sessionsPath: dir });
    const anchors = await m.recordTurn('c1', [{ role: 'assistant', content: 'appended turn' }]);

    const lines = nonEmptyLines(dayFile);
    expect(lines.length).toBe(2); // two distinct physical lines, not one fused malformed line
    expect(JSON.parse(lines[0]).content).toBe('seed turn');
    expect(JSON.parse(lines[1]).content).toBe('appended turn');
    expect(JSON.parse(lines[anchors[0].line - 1]).content).toBe('appended turn');
  });

  it('each day file has its own line count (rollover restarts at line 1 in the new file)', async () => {
    const m = new SessionManager({ sessionsPath: dir });
    jest.setSystemTime(new Date('2026-08-26T23:59:00.000Z'));
    const late = await m.recordTurn('c1', [{ role: 'user', content: 'late' }]);
    jest.setSystemTime(new Date('2026-08-27T00:01:00.000Z'));
    const early = await m.recordTurn('c1', [{ role: 'user', content: 'early' }]);
    expect(late).toEqual([{ file: '2026-08-26.jsonl', line: 1 }]);
    expect(early).toEqual([{ file: '2026-08-27.jsonl', line: 1 }]);
  });
});
