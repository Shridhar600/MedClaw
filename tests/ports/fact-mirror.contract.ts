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

    // --- queryPaused (recall Stage 1, KNEE-08 paused-with-pre_pause_summary) --------------

    it('queryPaused yields only paused facts and carries pre_pause_summary (KNEE-08)', async () => {
      await mirror.upsert([
        fact('gym-goal', { type: 'goal', status: 'paused', fields: { pre_pause_summary: '2x/week moderate' } }),
        fact('metformin', { type: 'medication', status: 'active' }),
        fact('old-goal', { type: 'goal', status: 'superseded' }),
      ]);
      const paused = await collect(mirror.queryPaused());
      expect(paused.map(f => f.entity)).toEqual(['gym-goal']);
      expect(paused[0].fields.pre_pause_summary).toBe('2x/week moderate');
    });

    it('queryPaused(type) filters by type and excludes v0 sentinels', async () => {
      await mirror.upsert([
        fact('gym-goal', { type: 'goal', status: 'paused' }),
        fact('somemed', { type: 'medication', status: 'paused' }),
        fact('ghost-goal', { type: 'goal', status: 'paused', version: 0 }),
      ]);
      const goals = await collect(mirror.queryPaused('goal'));
      expect(goals.map(f => f.entity)).toEqual(['gym-goal']);
    });

    // --- queryEntityHeads (recall Stage 2 suppression CONTRA-10 + stale fail-closed KNEE-10) -

    it('queryEntityHeads prefers an active lifecycle winner over a higher terminal version', async () => {
      await mirror.upsert([
        fact('metformin@v1', { entity: 'metformin', version: 1, status: 'retracted', createdAt: '2026-01-01T00:00:00.000Z' }),
        fact('metformin@v2', { entity: 'metformin', version: 2, status: 'superseded', createdAt: '2026-02-01T00:00:00.000Z' }),
        fact('metformin@v3', { entity: 'metformin', version: 3, status: 'active', createdAt: '2026-03-01T00:00:00.000Z' }),
        fact('naproxen@v1', { entity: 'naproxen', version: 1, status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }),
        fact('naproxen@v2', { entity: 'naproxen', version: 2, status: 'discontinued', createdAt: '2026-02-01T00:00:00.000Z' }),
      ]);
      const heads = await collect(mirror.queryEntityHeads());
      const byEntity = Object.fromEntries(heads.map(h => [h.entity, h]));
      expect(byEntity.metformin.version).toBe(3);
      expect(byEntity.metformin.status).toBe('active');
      expect(byEntity.metformin.createdAt).toBe('2026-03-01T00:00:00.000Z');
      expect(byEntity.naproxen.version).toBe(1);
      expect(byEntity.naproxen.status).toBe('active');
    });

    it('queryEntityHeads excludes v0 quarantine sentinels', async () => {
      await mirror.upsert([
        fact('ghost@v0', { entity: 'ghost', version: 0, status: 'active' }),
        fact('real@v1', { entity: 'real', version: 1, status: 'active' }),
      ]);
      const heads = await collect(mirror.queryEntityHeads());
      expect(heads.map(h => h.entity).sort()).toEqual(['real']);
    });

    it('queryEntityHeads resolves a version tie to a single deterministic head (latest createdAt) (F11)', async () => {
      await mirror.upsert([
        fact('dup-a', { entity: 'dupe', version: 2, status: 'superseded', createdAt: '2026-01-01T00:00:00.000Z' }),
        fact('dup-b', { entity: 'dupe', version: 2, status: 'active', createdAt: '2026-02-01T00:00:00.000Z' }),
      ]);
      const heads = (await collect(mirror.queryEntityHeads())).filter(h => h.entity === 'dupe');
      expect(heads).toHaveLength(1);
      expect(heads[0].id).toBe('dup-b'); // later createdAt wins the tie
    });
  });
}
