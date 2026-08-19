import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CuriosityQueue } from '../../src/memcore/curiosity-queue';
import type { CuriosityItem } from '../../src/memcore';
import { fixedClock, seqIdGen } from '../helpers/memcore-fixtures';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-curiosity-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const item = (o: Partial<CuriosityItem> = {}): Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'> => ({
  kind: 'follow-up',
  description: 'no report after Wednesday visit',
  ...o,
});

describe('CuriosityQueue.add', () => {
  it('persists curiosity.md at 0600 and returns the full CuriosityItem', async () => {
    const s = new CuriosityQueue(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('cq'), 'p1');
    const added = await s.add(item({ relatedEntity: 'knee' }));

    expect(added.id).toBe('cq-1');
    expect(added.profileId).toBe('p1');
    expect(added.createdAt).toBe('2026-08-18T10:00:00.000Z');
    expect(added.kind).toBe('follow-up');
    expect(added.relatedEntity).toBe('knee');

    const fp = path.join(tmpDir, 'curiosity.md');
    const content = await fs.promises.readFile(fp, 'utf-8');
    expect(content).toContain('## cq-1');
    expect(content).toContain('- profileId: p1');
    expect(content).toContain('no report after Wednesday visit');
    expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
  });

  it('is additive — a second add keeps the first item', async () => {
    const s = new CuriosityQueue(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('cq'), 'p1');
    await s.add(item());
    await s.add(item({ description: 'recheck HbA1c in 3 months', kind: 'medication-reminder', critical: true, dueAt: '2026-09-18T00:00:00.000Z' }));
    const items = await s.list();
    expect(items).toHaveLength(2);
    expect(items.map(i => i.description)).toEqual([
      'no report after Wednesday visit',
      'recheck HbA1c in 3 months',
    ]);
  });
});

describe('CuriosityQueue.list', () => {
  it('round-trips every current CuriosityItem field', async () => {
    const s = new CuriosityQueue(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('cq'), 'p1');
    await s.add(item({ kind: 'lab-correlation', description: 'sleep vs hba1c', critical: true, relatedEntity: 'hba1c', dueAt: '2026-09-18T00:00:00.000Z' }));

    const items = await s.list();
    expect(items).toEqual([
      expect.objectContaining({
        id: 'cq-1',
        profileId: 'p1',
        kind: 'lab-correlation',
        description: 'sleep vs hba1c',
        critical: true,
        relatedEntity: 'hba1c',
        createdAt: '2026-08-18T10:00:00.000Z',
        dueAt: '2026-09-18T00:00:00.000Z',
      }),
    ]);
  });

  it('returns [] when the file does not exist', async () => {
    const s = new CuriosityQueue(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('cq'), 'p1');
    expect(await s.list()).toEqual([]);
  });
});

describe('CuriosityQueue.resolve', () => {
  it('removes the item from list() and returns true; false for an unknown id', async () => {
    const s = new CuriosityQueue(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('cq'), 'p1');
    await s.add(item());
    await s.add(item({ description: 'second' }));

    expect(await s.resolve('cq-1')).toBe(true);
    const items = await s.list();
    expect(items.map(i => i.description)).toEqual(['second']);

    expect(await s.resolve('cq-1')).toBe(false); // already resolved — not listed
    expect(await s.resolve('nope')).toBe(false);
  });

  it('a resolved item stays resolved across a fresh store on the same dir', async () => {
    const s = new CuriosityQueue(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('cq'), 'p1');
    await s.add(item());
    await s.add(item({ description: 'second' }));
    await s.resolve('cq-1');

    const s2 = new CuriosityQueue(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('cq'), 'p1');
    const items = await s2.list();
    expect(items.map(i => i.description)).toEqual(['second']);
  });
});

describe('CuriosityQueue corrupt-file handling', () => {
  it('degrades with a warning instead of crashing when curiosity.md is corrupt', async () => {
    const s = new CuriosityQueue(tmpDir, fixedClock('2026-08-18T10:00:00Z'), seqIdGen('cq'), 'p1');
    await s.add(item());
    // Corrupt the file with garbage after the first block.
    fs.appendFileSync(path.join(tmpDir, 'curiosity.md'), '## broken\nno metadata here\n');

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const items = await s.list();
      // First item survives; the corrupt block is skipped.
      expect(items.map(i => i.description)).toEqual(['no report after Wednesday visit']);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});