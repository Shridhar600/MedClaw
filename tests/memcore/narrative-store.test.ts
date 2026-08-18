import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NarrativeStore } from '../../src/memcore';
import { fixedClock } from '../helpers/memcore-fixtures';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-narrative-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const clockAt = (iso: string) => fixedClock(iso);

describe('NarrativeStore.append', () => {
  it('returns a real memory/<date>.md#L<n> anchor and persists the entry 0600', async () => {
    const s = new NarrativeStore(tmpDir, clockAt('2026-08-18T14:30:00Z'));
    const r = await s.append({ text: 'walked 30 minutes, knee felt fine' });

    expect(r.date).toBe('2026-08-18');
    expect(r.anchor).toMatch(/^memory\/2026-08-18\.md#L\d+$/);
    expect(r.lineStart).toBeGreaterThan(0);

    const fp = path.join(tmpDir, 'memory', '2026-08-18.md');
    const content = await fs.promises.readFile(fp, 'utf-8');
    expect(content).toContain('walked 30 minutes, knee felt fine');
    expect(content).toContain('# 2026-08-18');
    // The anchored line number actually points at the entry.
    const lines = content.split('\n');
    expect(lines[r.lineStart - 1]).toContain('walked 30 minutes, knee felt fine');
    expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
  });

  it('is additive — a second append never mutates the first entry', async () => {
    const s = new NarrativeStore(tmpDir, clockAt('2026-08-18T09:00:00Z'));
    const first = await s.append({ text: 'first note' });
    await s.append({ text: 'second note' });

    const content = (await s.read('2026-08-18'))!;
    expect(content).toContain('first note');
    expect(content).toContain('second note');
    // The first entry is still exactly where its anchor said it was.
    const lines = content.split('\n');
    expect(lines[first.lineStart - 1]).toContain('first note');
  });

  it('stores a verbatim quote exactly, blockquoted, tagged with its language', async () => {
    const s = new NarrativeStore(tmpDir, clockAt('2026-08-18T14:30:00Z'));
    await s.append({ text: 'patient described the pain', verbatim: 'mera ghutna dukhta hai', language: 'hi' });

    const content = (await s.read('2026-08-18'))!;
    expect(content).toContain('mera ghutna dukhta hai'); // verbatim preserved exactly
    expect(content).toMatch(/^\s*>.*mera ghutna dukhta hai/m); // blockquoted
    expect(content).toContain('(lang: hi)');
  });

  it('creates and extends a "## Ledger writes" cross-anchor section', async () => {
    const s = new NarrativeStore(tmpDir, clockAt('2026-08-18T14:30:00Z'));
    await s.append({ text: 'started metformin' });
    const anchor1 = await s.appendLedgerAnchor('2026-08-18', 'metformin', 'metformin@v1');
    const anchor2 = await s.appendLedgerAnchor('2026-08-18', 'ibuprofen', 'ibuprofen@v2');

    const content = (await s.read('2026-08-18'))!;
    expect(content).toContain('## Ledger writes');
    expect(content).toContain('- metformin → metformin@v1');
    expect(content).toContain('- ibuprofen → ibuprofen@v2');
    expect(anchor1).toMatch(/^memory\/2026-08-18\.md#L\d+$/);
    expect(anchor2).toMatch(/^memory\/2026-08-18\.md#L\d+$/);
    // Log content still present alongside the cross-anchor section.
    expect(content).toContain('started metformin');
  });

  it('uses an explicit date over the clock so both lanes agree on the day (F20)', async () => {
    const s = new NarrativeStore(tmpDir, clockAt('2026-08-18T00:00:00Z'));
    const r = await s.append({ text: 'backdated note', date: '2026-08-12' });
    expect(r.date).toBe('2026-08-12');
    expect(await s.read('2026-08-12')).toContain('backdated note');
    expect(await s.read('2026-08-18')).toBeNull(); // nothing landed on the clock day
  });

  it('read() returns null for a day with no entries', async () => {
    const s = new NarrativeStore(tmpDir, clockAt('2026-08-18T00:00:00Z'));
    expect(await s.read('2026-01-01')).toBeNull();
  });
});
