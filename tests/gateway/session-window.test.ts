import * as fs from 'fs';
import * as path from 'path';
import {
  loadWindow,
  saveWindow,
  latestDayFileEof,
  resolveWindow,
  dateKey,
  type SessionWindow,
} from '../../src/gateway/session-window';
import { makeTestTemp } from '../helpers/test-temp';

describe('session-window', () => {
  let dir: string;
  beforeEach(() => { dir = makeTestTemp('sw-'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const win = (over: Partial<SessionWindow> = {}): SessionWindow => ({
    summaryBlock: 'prior summary',
    verbatimFrom: { file: '2026-08-25.jsonl', line: 4 },
    ...over,
  });

  it('saveWindow → loadWindow round-trips and writes the file 0600', () => {
    const p = path.join(dir, 'session-window.json');
    const w = win({ lastPromptTokens: 1234, lastPromptTokensEstimated: false });
    saveWindow(p, w);
    expect(loadWindow(p)).toEqual(w);
    expect((fs.statSync(p).mode & 0o777).toString(8)).toBe('600');
  });

  it('loadWindow returns null for a missing file', () => {
    expect(loadWindow(path.join(dir, 'nope.json'))).toBeNull();
  });

  it('loadWindow returns null (never throws) for corrupt JSON', () => {
    const p = path.join(dir, 'session-window.json');
    fs.writeFileSync(p, '{not valid json');
    expect(loadWindow(p)).toBeNull();
  });

  it('loadWindow returns null for a valid-JSON but wrong-shape object', () => {
    const p = path.join(dir, 'session-window.json');
    fs.writeFileSync(p, JSON.stringify({ summaryBlock: 'x' })); // missing verbatimFrom
    expect(loadWindow(p)).toBeNull();
  });

  it('latestDayFileEof picks the newest day file and counts its non-empty lines', () => {
    fs.writeFileSync(path.join(dir, '2026-08-24.jsonl'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(dir, '2026-08-25.jsonl'), 'x\ny\n');
    expect(latestDayFileEof(dir)).toEqual({ file: '2026-08-25.jsonl', line: 2 });
  });

  it('latestDayFileEof ignores non-day-file entries and returns {file:"",line:0} when none exist', () => {
    fs.writeFileSync(path.join(dir, 'session-window.json'), '{}');
    fs.writeFileSync(path.join(dir, '.migrated'), '');
    expect(latestDayFileEof(dir)).toEqual({ file: '', line: 0 });
  });

  it('latestDayFileEof returns {file:"",line:0} for a missing directory', () => {
    expect(latestDayFileEof(path.join(dir, 'does-not-exist'))).toEqual({ file: '', line: 0 });
  });

  it('resolveWindow: absent window + day files ⇒ empty window at latest-day EOF', () => {
    fs.writeFileSync(path.join(dir, '2026-08-25.jsonl'), 'x\ny\n');
    const p = path.join(dir, 'session-window.json');
    expect(resolveWindow(p, dir)).toEqual({
      summaryBlock: '',
      verbatimFrom: { file: '2026-08-25.jsonl', line: 2 },
    });
  });

  it('resolveWindow: absent window + no day files ⇒ {file:"",line:0}', () => {
    const p = path.join(dir, 'session-window.json');
    expect(resolveWindow(p, dir)).toEqual({
      summaryBlock: '',
      verbatimFrom: { file: '', line: 0 },
    });
  });

  it('resolveWindow: corrupt window + day files ⇒ latest-day EOF, not {file:"",line:0}', () => {
    fs.writeFileSync(path.join(dir, '2026-08-25.jsonl'), 'x\ny\n');
    const p = path.join(dir, 'session-window.json');
    fs.writeFileSync(p, '{corrupt');
    expect(resolveWindow(p, dir)).toEqual({
      summaryBlock: '',
      verbatimFrom: { file: '2026-08-25.jsonl', line: 2 },
    });
  });

  it('resolveWindow: a present, valid window is returned unchanged', () => {
    const p = path.join(dir, 'session-window.json');
    const w = win({ lastPromptTokens: 99 });
    fs.writeFileSync(path.join(dir, '2026-08-25.jsonl'), 'a\nb\nc\nd\n');
    saveWindow(p, w);
    expect(resolveWindow(p, dir)).toEqual(w);
  });
});

describe('dateKey (one shared UTC day key)', () => {
  it('returns the UTC YYYY-MM-DD (matching NarrativeStore)', () => {
    expect(dateKey(new Date('2026-08-25T14:00:00.000Z'))).toBe('2026-08-25');
  });

  it('a 00:30 IST turn maps to the PREVIOUS UTC day (TZ-agnostic archive; )', () => {
    expect(dateKey(new Date('2026-08-26T00:30:00.000+05:30'))).toBe('2026-08-25');
  });
});
