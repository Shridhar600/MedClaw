import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionManager } from '../../src/gateway/session';
import { SqliteSessionIndex } from '../../src/indexstore';
import {
  dateKey,
  countDayFileLines,
  deriveWindowAnchor,
  loadWindow,
  readLinesAfter,
  walkBackAnchor,
  type ArchiveTail,
} from '../../src/gateway/session-window';

const fsReal = jest.requireActual<typeof import('fs')>('fs');

const tmpDirs: string[] = [];

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeDay(dir: string, day: string, count: number): string {
  const filePath = path.join(dir, `${day}.jsonl`);
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({ index, day }));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

describe('RR-9a C-38 bounded session-window reads', () => {
  it('uses a current archive tail watermark without reading any JSONL file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-window-'));
    tmpDirs.push(dir);
    writeDay(dir, '2026-08-28', 40);
    const latest = writeDay(dir, '2026-08-29', 30);
    const tail: ArchiveTail = {
      file: '2026-08-29.jsonl',
      line: 30,
      byteLength: fs.statSync(latest).size,
    };
    const readFile = jest.spyOn(fsReal, 'readFileSync');

    const result = deriveWindowAnchor(dir, 5, tail);

    expect(result).toEqual({
      anchor: { file: '2026-08-29.jsonl', line: 25 },
      source: 'watermark',
    });
    expect(readFile.mock.calls.filter(([file]) => String(file).endsWith('.jsonl'))).toHaveLength(0);
  });

  it('falls back from a stale watermark to the identical physical-anchor result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-window-'));
    tmpDirs.push(dir);
    writeDay(dir, '2026-08-27', 3);
    writeDay(dir, '2026-08-28', 4);
    const latest = writeDay(dir, '2026-08-29', 2);
    const stale: ArchiveTail = {
      file: '2026-08-29.jsonl',
      line: 2,
      byteLength: fs.statSync(latest).size - 1,
    };

    expect(deriveWindowAnchor(dir, 6, stale)).toEqual({
      anchor: walkBackAnchor(dir, 6),
      source: 'fallback',
    });
  });

  it('persists a separate physical tail watermark for each chat archive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-window-'));
    tmpDirs.push(dir);
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-29T10:00:00.000Z'));
    const manager = new SessionManager({ sessionsPath: dir, perChatArchive: true });

    await manager.recordTurn('chat-a', [
      { role: 'user', content: 'a1' },
      { role: 'assistant', content: 'a2' },
    ]);
    await manager.recordTurn('chat-b', [{ role: 'user', content: 'b1' }]);

    const day = `${dateKey(new Date())}.jsonl`;
    const aWindow = loadWindow(path.join(dir, 'session-window.chat-a.json'));
    const bWindow = loadWindow(path.join(dir, 'session-window.chat-b.json'));
    expect(aWindow?.archiveTail).toEqual({
      file: day,
      line: 2,
      byteLength: fs.statSync(path.join(dir, 'chat-a', day)).size,
    });
    expect(bWindow?.archiveTail).toEqual({
      file: day,
      line: 1,
      byteLength: fs.statSync(path.join(dir, 'chat-b', day)).size,
    });
  });

  it('rebuilds the session index without slurping the archive into readFileSync', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-index-'));
    tmpDirs.push(dir);
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify({
      timestamp: `2026-08-29T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
      role: 'user',
      content: `archive marker ${index}`,
      chatId: 'chat-1',
    }));
    const dayFile = path.join(sessionsDir, '2026-08-29.jsonl');
    fs.writeFileSync(dayFile, `${lines.join('\n')}\n`);
    const index = new SqliteSessionIndex({ dbPath: path.join(dir, 'search.db') });
    const readFile = jest.spyOn(fsReal, 'readFileSync');

    expect(index.rebuildFromDayFiles(sessionsDir)).toBe(true);
    expect(readFile.mock.calls.filter(([file]) => String(file).endsWith('.jsonl'))).toHaveLength(0);
    expect(index.search('archive marker 1199', { chatId: 'chat-1' }).hits[0].line).toBe(1200);
    index.close();
  });

  it('preserves a JSONL record that crosses the fixed read-buffer boundary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-boundary-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, '2026-08-29.jsonl');
    const long = JSON.stringify({ content: 'x'.repeat(70_000), marker: 'long-line' });
    fs.writeFileSync(filePath, `${long}\nshort\n`);

    expect(countDayFileLines(filePath)).toBe(2);
    const lines = readLinesAfter(dir, { file: '', line: 0 });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0].raw).marker).toBe('long-line');
    expect(lines[1].raw).toBe('short');
  });
});
