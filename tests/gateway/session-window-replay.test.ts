import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listDayFiles, walkBackAnchor, readLinesAfter } from '../../src/gateway/session-window';

// P2b Wave D-1 / D1.5 — the resume substrate: enumerate day files, compute the tail's start anchor by
// walking back K lines from the archive EOF, and read every archive line strictly after a `verbatimFrom`
// anchor. Anchors are EOF-EXCLUSIVE: `readLinesAfter(from)` skips the first `from.line` lines of
// `from.file`, so `walkBackAnchor(dir, K)` returns the anchor for which `readLinesAfter` yields exactly
// the last K lines (a fresh window at EOF ⇒ zero tail).

describe('session-window replay helpers (D1.5)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swr-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // Write `n` JSONL entries `{i: <fileTag>-<k>}` to a day file, return the basename.
  const writeDay = (day: string, tag: string, n: number): string => {
    const lines = Array.from({ length: n }, (_v, k) => JSON.stringify({ i: `${tag}-${k + 1}` }));
    fs.writeFileSync(path.join(dir, `${day}.jsonl`), lines.join('\n') + '\n');
    return `${day}.jsonl`;
  };
  const tags = (rows: { raw: string }[]): string[] => rows.map((r) => JSON.parse(r.raw).i);

  it('listDayFiles returns sorted YYYY-MM-DD.jsonl basenames and ignores other files', () => {
    writeDay('2026-08-26', 'B', 1);
    writeDay('2026-08-25', 'A', 1);
    fs.writeFileSync(path.join(dir, 'session-window.json'), '{}');
    fs.writeFileSync(path.join(dir, 'active-c1.jsonl'), 'x\n');
    expect(listDayFiles(dir)).toEqual(['2026-08-25.jsonl', '2026-08-26.jsonl']);
  });

  it('walkBackAnchor returns {file:"",line:0} for an empty/absent dir', () => {
    expect(walkBackAnchor(dir, 3)).toEqual({ file: '', line: 0 });
    expect(walkBackAnchor(path.join(dir, 'nope'), 3)).toEqual({ file: '', line: 0 });
  });

  it('walkBackAnchor within one file: K back from EOF is an exclusive lower bound', () => {
    const f = writeDay('2026-08-26', 'A', 5);
    expect(walkBackAnchor(dir, 0)).toEqual({ file: f, line: 5 }); // EOF ⇒ empty tail
    expect(walkBackAnchor(dir, 2)).toEqual({ file: f, line: 3 }); // last 2 lines
    expect(walkBackAnchor(dir, 5)).toEqual({ file: f, line: 0 }); // whole file
    expect(walkBackAnchor(dir, 99)).toEqual({ file: f, line: 0 }); // clamp: never past start
  });

  it('walkBackAnchor crosses the day-file boundary', () => {
    writeDay('2026-08-25', 'A', 3);
    writeDay('2026-08-26', 'B', 2);
    // total 5. Last 4 ⇒ skip 1 line of the earliest file.
    expect(walkBackAnchor(dir, 4)).toEqual({ file: '2026-08-25.jsonl', line: 1 });
    // Last 2 ⇒ all of B, none of A.
    expect(walkBackAnchor(dir, 2)).toEqual({ file: '2026-08-26.jsonl', line: 0 });
  });

  it('readLinesAfter({file:"",line:0}) returns the whole archive in order with anchors', () => {
    writeDay('2026-08-25', 'A', 2);
    writeDay('2026-08-26', 'B', 2);
    const rows = readLinesAfter(dir, { file: '', line: 0 });
    expect(tags(rows)).toEqual(['A-1', 'A-2', 'B-1', 'B-2']);
    expect(rows.map((r) => ({ file: r.file, line: r.line }))).toEqual([
      { file: '2026-08-25.jsonl', line: 1 },
      { file: '2026-08-25.jsonl', line: 2 },
      { file: '2026-08-26.jsonl', line: 1 },
      { file: '2026-08-26.jsonl', line: 2 },
    ]);
  });

  it('readLinesAfter is the exact inverse of walkBackAnchor (returns the last K lines)', () => {
    writeDay('2026-08-25', 'A', 3);
    writeDay('2026-08-26', 'B', 2);
    for (const k of [0, 1, 2, 4, 5]) {
      const rows = readLinesAfter(dir, walkBackAnchor(dir, k));
      expect(rows).toHaveLength(k);
    }
    // last-4 content check
    expect(tags(readLinesAfter(dir, walkBackAnchor(dir, 4)))).toEqual(['A-2', 'A-3', 'B-1', 'B-2']);
  });

  it('readLinesAfter at EOF returns [] and skips malformed lines', () => {
    fs.writeFileSync(path.join(dir, '2026-08-26.jsonl'), '{"i":"ok"}\nnot json\n{"i":"ok2"}\n');
    // EOF anchor ⇒ nothing after it.
    expect(readLinesAfter(dir, { file: '2026-08-26.jsonl', line: 3 })).toEqual([]);
    // From the start: the malformed physical line still occupies its slot (anchor line 2) but is
    // dropped from the parsed output — callers parse r.raw and skip failures.
    const rows = readLinesAfter(dir, { file: '', line: 0 });
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3]);
    expect(rows[1].raw).toBe('not json');
  });
});
