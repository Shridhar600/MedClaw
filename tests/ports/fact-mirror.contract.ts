// Shared FactMirror contract (P2 Task A1). Any FactMirror adapter must pass this suite —
// the rebuildable-from-Markdown mirror of the ledger that recall Stage 1 reads.
//
// NOT a test file itself (jest testMatch is **/*.test.ts) — it only exports the suite.
// Import and invoke from an adapter's own *.test.ts with a factory that builds a fresh,
// isolated adapter per call.

import type { FactMirror, FactRecord } from '../../src/ports';

export type ContractMirror = FactMirror & { close?: () => void };
export type MakeMirror = () => ContractMirror;

async function collect(it: AsyncIterable<FactRecord>): Promise<FactRecord[]> {
  const out: FactRecord[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function fact(id: string, over: Partial<FactRecord> = {}): FactRecord {
  return {
    id,
    profileId: over.profileId ?? 'default',
    entity: over.entity ?? id,
    type: over.type ?? 'medication',
    version: over.version ?? 1,
    status: over.status ?? 'active',
    fields: over.fields ?? { dose: '500mg' },
    safetyRelevant: over.safetyRelevant ?? false,
    authority: over.authority ?? 'user',
    confidence: over.confidence ?? 0.9,
    createdAt: over.createdAt ?? '2026-08-12T00:00:00.000Z',
    ...over,
  };
}

export function runFactMirrorContract(makeMirror: MakeMirror): void {
  describe('FactMirror contract (P2 A1)', () => {
    let mirror: ContractMirror;

    beforeEach(() => {
      mirror = makeMirror();
    });
    afterEach(() => {
      mirror.close?.();
    });

    it('upsert then queryActive(type) yields only active facts of that type', async () => {
      await mirror.upsert([
        fact('metformin', { type: 'medication', status: 'active' }),
        fact('lisinopril', { type: 'medication', status: 'superseded' }),
        fact('knee-injury', { type: 'condition', status: 'active' }),
      ]);
      const meds = await collect(mirror.queryActive('medication'));
      expect(meds.map(f => f.entity).sort()).toEqual(['metformin']);
    });

    it('queryActive(undefined, entity) filters by entity across types', async () => {
      await mirror.upsert([
        fact('metformin', { type: 'medication', status: 'active' }),
        fact('knee-injury', { type: 'condition', status: 'active' }),
      ]);
      const rows = await collect(mirror.queryActive(undefined, 'knee-injury'));
      expect(rows).toHaveLength(1);
      expect(rows[0].entity).toBe('knee-injury');
      expect(rows[0].type).toBe('condition');
    });

    it('round-trips authority / confidence / episodeId + fields (v2-M-2)', async () => {
      await mirror.upsert([
        fact('metformin', {
          authority: 'doctor',
          confidence: 0.42,
          episodeId: 'ep-7',
          safetyRelevant: true,
          fields: { dose: '850mg', known_side_effects: ['nausea', 'diarrhea'] },
        }),
      ]);
      const [row] = await collect(mirror.queryActive('medication'));
      expect(row.authority).toBe('doctor');
      expect(row.confidence).toBeCloseTo(0.42, 6);
      expect(row.episodeId).toBe('ep-7');
      expect(row.safetyRelevant).toBe(true);
      expect(row.fields).toEqual({ dose: '850mg', known_side_effects: ['nausea', 'diarrhea'] });
    });

    it('upsert is idempotent by id (re-upsert updates in place, no duplicate)', async () => {
      await mirror.upsert([fact('metformin', { fields: { dose: '500mg' } })]);
      await mirror.upsert([fact('metformin', { fields: { dose: '1000mg' } })]);
      const rows = await collect(mirror.queryActive('medication'));
      expect(rows).toHaveLength(1);
      expect(rows[0].fields).toEqual({ dose: '1000mg' });
    });

    it('excludes non-active facts (superseded / retracted / discontinued)', async () => {
      await mirror.upsert([
        fact('a', { status: 'superseded' }),
        fact('b', { status: 'retracted' }),
        fact('c', { status: 'discontinued' }),
        fact('d', { status: 'active' }),
      ]);
      const rows = await collect(mirror.queryActive('medication'));
      expect(rows.map(f => f.entity)).toEqual(['d']);
    });

    it('excludes v0 quarantine sentinels (version < 1) from active queries (M-5 discipline)', async () => {
      await mirror.upsert([
        fact('ghostmed', { version: 0, status: 'active' }),
        fact('realmed', { version: 1, status: 'active' }),
      ]);
      const rows = await collect(mirror.queryActive('medication'));
      expect(rows.map(f => f.entity)).toEqual(['realmed']);
    });

    it('rebuild clears the mirror and repopulates from the given set', async () => {
      await mirror.upsert([fact('stale', { status: 'active' })]);
      await mirror.rebuild([
        fact('fresh1', { status: 'active' }),
        fact('fresh2', { status: 'active' }),
      ]);
      const rows = await collect(mirror.queryActive('medication'));
      expect(rows.map(f => f.entity).sort()).toEqual(['fresh1', 'fresh2']);
    });
  });
}
