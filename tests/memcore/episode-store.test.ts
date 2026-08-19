import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EpisodeStore } from '../../src/memcore/episode-store';
import { fixedClock, seqIdGen } from '../helpers/memcore-fixtures';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-episodes-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('EpisodeStore.create', () => {
  it('persists episodes/<id>.md at 0600 and returns an Episode with a minted id', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    const ep = await s.create({ title: 'knee-injury', profileId: 'p1' });

    expect(ep.id).toBe('ep-1');
    expect(ep.title).toBe('knee-injury');
    expect(ep.status).toBe('open');
    expect(ep.createdAt).toBe('2026-08-18T10:00:00.000Z');
    expect(ep.updatedAt).toBe('2026-08-18T10:00:00.000Z');

    const fp = path.join(tmpDir, 'episodes', 'ep-1.md');
    const content = await fs.promises.readFile(fp, 'utf-8');
    expect(content).toContain('# knee-injury');
    expect(content).toContain('- status: open');
    expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
  });
});

describe('EpisodeStore.get', () => {
  it('returns null for an unknown id', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    expect(await s.get('nope')).toBeNull();
  });

  it('round-trips a created episode including arrays and a note', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    await s.create({
      title: 'knee-injury',
      profileId: 'p1',
      status: 'resolving',
      bodyRegions: ['knee', 'ankle'],
      note: 'MRI-confirmed mild MCL sprain',
    });

    const ep = await s.get('ep-1');
    expect(ep).not.toBeNull();
    expect(ep!.status).toBe('resolving');
    expect(ep!.bodyRegions).toEqual(['knee', 'ankle']);
    expect(ep!.note).toBe('MRI-confirmed mild MCL sprain');
  });
});

describe('EpisodeStore.update', () => {
  it('changes status/note and bumps updatedAt', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    await s.create({ title: 'knee-injury', profileId: 'p1' });
    const later = fixedClock('2026-08-20T10:00:00Z');
    const s2 = new EpisodeStore(tmpDir, later, seqIdGen('ep'));

    const ep = await s2.update('ep-1', { status: 'resolved', note: 'healed' });
    expect(ep!.status).toBe('resolved');
    expect(ep!.note).toBe('healed');
    expect(ep!.updatedAt).toBe('2026-08-20T10:00:00.000Z');
    // createdAt untouched
    expect(ep!.createdAt).toBe('2026-08-18T10:00:00.000Z');
  });

  it('returns null when the episode does not exist', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    expect(await s.update('ghost', { status: 'resolved' })).toBeNull();
  });
});

describe('EpisodeStore.link', () => {
  it('appends unique fact ids to linkedFactIds and bumps updatedAt', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    await s.create({ title: 'knee-injury', profileId: 'p1' });

    const ep = await s.link('ep-1', ['ibuprofen@v1', 'knee-pain@v1']);
    expect(ep!.linkedFactIds).toEqual(['ibuprofen@v1', 'knee-pain@v1']);

    // link is idempotent on re-add
    const ep2 = await s.link('ep-1', ['ibuprofen@v1', 'mri@v1']);
    expect(ep2!.linkedFactIds).toEqual(['ibuprofen@v1', 'knee-pain@v1', 'mri@v1']);
  });
});

describe('EpisodeStore.remove', () => {
  it('deletes the file and returns true; false for a missing episode', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    await s.create({ title: 'knee-injury', profileId: 'p1' });

    expect(await s.remove('ep-1')).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'episodes', 'ep-1.md'))).toBe(false);
    expect(await s.remove('ep-1')).toBe(false);
  });
});

describe('EpisodeStore.list (paged)', () => {
  it('list({limit:2}) returns 2 episodes + a cursor; the cursor returns the last (Task 7)', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    await s.create({ title: 'one', profileId: 'p1' });
    await s.create({ title: 'two', profileId: 'p1' });
    await s.create({ title: 'three', profileId: 'p1' });

    const page1 = await s.list({ limit: 2 });
    expect(page1.items.map(e => e.id)).toEqual(['ep-1', 'ep-2']);
    expect(page1.nextCursor).toBe('ep-2');

    const page2 = await s.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map(e => e.id)).toEqual(['ep-3']);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('list() with no limit returns every episode', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    await s.create({ title: 'one', profileId: 'p1' });
    await s.create({ title: 'two', profileId: 'p1' });

    const all = await s.list();
    expect(all.items.map(e => e.id)).toEqual(['ep-1', 'ep-2']);
    expect(all.nextCursor).toBeUndefined();
  });

  it('list({status}) filters to matching episodes', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    await s.create({ title: 'one', profileId: 'p1' });
    await s.create({ title: 'two', profileId: 'p1', status: 'resolved' });
    await s.create({ title: 'three', profileId: 'p1' });

    const open = await s.list({ status: 'open' });
    expect(open.items.map(e => e.id)).toEqual(['ep-1', 'ep-3']);
    expect(open.nextCursor).toBeUndefined();
  });

  it('parses only the first page — a corrupt third file is never touched on page 1 (specs/16 §3)', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    await s.create({ title: 'one', profileId: 'p1' });
    await s.create({ title: 'two', profileId: 'p1' });
    // Third file is corrupt; if the pager parsed the whole dir it would hit it.
    fs.mkdirSync(path.join(tmpDir, 'episodes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'episodes', 'ep-3.md'), 'not a real episode');

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const page = await s.list({ limit: 2 });
      expect(page.items.map(e => e.id)).toEqual(['ep-1', 'ep-2']);
      expect(warnSpy).not.toHaveBeenCalled(); // corrupt file untouched by page 1
    } finally {
      warnSpy.mockRestore();
    }

    // Advancing with the cursor hits the corrupt file and skips it, not a crash.
    const page2 = await s.list({ limit: 2, cursor: 'ep-2' });
    expect(page2.items).toEqual([]);
  });
});

describe('EpisodeStore corrupt-file handling', () => {
  it('skips a corrupt episode file with a warning instead of crashing', async () => {
    const s = new EpisodeStore(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('ep'));
    await s.create({ title: 'good', profileId: 'p1' });
    // Hand-write a corrupt file (no title / metadata).
    fs.mkdirSync(path.join(tmpDir, 'episodes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'episodes', 'bad.md'), 'not a real episode');

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await s.list();
      expect(result.items.map(e => e.id)).toEqual(['ep-1']);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});