import { runNightlySweep } from '../../src/scheduler/transcript-sweep-job';
import type { NightlySweepDeps } from '../../src/scheduler/transcript-sweep-job';
import type { AddCuriosityInput } from '../../src/memcore';
import type { SweepLexicon } from '../../src/memcore';

const LEX: SweepLexicon = {
  med: ['naproxen', 'metformin'],
  symptom: ['headache'],
  appointment: ['appointment'],
};

const userLine = (content: string) =>
  JSON.stringify({ timestamp: '2026-08-30T10:00:00.000Z', role: 'user', content, chatId: 'c1' });

function baseDeps(overrides: Partial<NightlySweepDeps> = {}): { deps: NightlySweepDeps; added: AddCuriosityInput[] } {
  const added: AddCuriosityInput[] = [];
  const deps: NightlySweepDeps = {
    readDayLines: async () => [
      userLine('took naproxen this morning'), // med miss -> critical
      userLine('bad headache all afternoon'), // symptom miss
      userLine('started metformin again'),    // logged -> no item
    ],
    ledgerEntitiesForDay: async () => new Set(['metformin']),
    listCuriosity: async () => [],
    addCuriosity: async (item) => { added.push(item); },
    lexicon: LEX,
    now: () => new Date('2026-08-31T02:00:00.000Z'),
    ...overrides,
  };
  return { deps, added };
}

describe('runNightlySweep', () => {
  it('adds exactly the golden items (2 misses, med critical) to the curiosity queue', async () => {
    const { deps, added } = baseDeps();
    const result = await runNightlySweep(deps);

    expect(result).toEqual({ scanned: true, added: 2 });
    expect(added).toHaveLength(2);
    const med = added.find(i => i.relatedEntity === 'naproxen');
    const sym = added.find(i => i.relatedEntity === 'headache');
    expect(med?.critical).toBe(true);
    expect(sym?.critical).toBeFalsy();
    expect(added.every(i => i.kind === 'missing-data')).toBe(true);
  });

  it('asks its accessors for YESTERDAY (UTC) relative to now', async () => {
    let seenLines: Date | undefined;
    let seenLedger: Date | undefined;
    const { deps } = baseDeps({
      now: () => new Date('2026-08-31T02:00:00.000Z'),
      readDayLines: async (d) => { seenLines = d; return []; },
      ledgerEntitiesForDay: async (d) => { seenLedger = d; return new Set(); },
    });
    await runNightlySweep(deps);
    expect(seenLines?.toISOString().slice(0, 10)).toBe('2026-08-30');
    expect(seenLedger?.toISOString().slice(0, 10)).toBe('2026-08-30');
  });

  it('swallows a read failure — returns not-scanned, never throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { deps } = baseDeps({ readDayLines: async () => { throw new Error('disk gone'); } });
      const result = await runNightlySweep(deps);
      expect(result).toEqual({ scanned: false, added: 0 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('continues past a per-item add failure (best-effort persistence)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      const { deps } = baseDeps({
        addCuriosity: async () => { calls++; if (calls === 1) throw new Error('write failed'); },
      });
      const result = await runNightlySweep(deps);
      expect(result.scanned).toBe(true);
      expect(result.added).toBe(1); // one failed, one succeeded — no throw
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('respects an existing curiosity item (no duplicate for the same entity)', async () => {
    const { deps, added } = baseDeps({
      listCuriosity: async () => [
        { id: 'x', profileId: 'p1', kind: 'missing-data', description: 'Did I miss logging naproxen yesterday?', relatedEntity: 'naproxen', createdAt: '2026-08-29T00:00:00.000Z' },
      ],
    });
    await runNightlySweep(deps);
    expect(added.map(i => i.relatedEntity)).toEqual(['headache']);
  });
});
