import { chunkHasStaleEntity } from '../../src/recall';
import type { FactRecord } from '../../src/ports';

// E1.1 (CONTRA-06/08 substrate): a pure, DRY stale-entity predicate extracted from the recall
// engine's Stage-2 suppression. A chunk is stale when it mentions an entity whose CURRENT HEAD is
// terminal (retracted / discontinued / superseded). memory_search's status:active filter reuses it.
function head(entity: string, status: string, extra: Partial<FactRecord> = {}): FactRecord {
  return {
    id: `${entity}-v1`, profileId: 'p1', entity, type: 'medication', version: 1,
    status, fields: {}, safetyRelevant: false, authority: 'user', confidence: 1,
    createdAt: '2026-08-01T00:00:00.000Z', ...extra,
  };
}

describe('chunkHasStaleEntity', () => {
  it('is true when the chunk mentions an entity whose head is discontinued', () => {
    const heads = [head('metformin', 'discontinued')];
    expect(chunkHasStaleEntity('metformin — discontinued 2026-08-05 (per doctor).', heads)).toBe(true);
  });

  it('is true for retracted and superseded heads', () => {
    expect(chunkHasStaleEntity('I take naproxen for the knee', [head('naproxen', 'retracted')])).toBe(true);
    expect(chunkHasStaleEntity('ibuprofen 400mg', [head('ibuprofen', 'superseded')])).toBe(true);
  });

  it('is false when the matched entity head is active', () => {
    expect(chunkHasStaleEntity('lisinopril 10mg daily', [head('lisinopril', 'active')])).toBe(false);
  });

  it('is false when no head entity appears in the chunk', () => {
    expect(chunkHasStaleEntity('feeling nauseous lately', [head('metformin', 'discontinued')])).toBe(false);
  });

  it('matches morphological variants (plural mentions)', () => {
    // matchEntities singularizes both sides, so a plural mention still matches the entity word.
    expect(chunkHasStaleEntity('my UTIs cleared up', [head('uti', 'discontinued', { type: 'symptom' })])).toBe(true);
  });

  it('requires ALL entity words to appear (multi-word entity)', () => {
    const heads = [head('blood pressure', 'discontinued', { type: 'metric' })];
    expect(chunkHasStaleEntity('my blood pressure reading', heads)).toBe(true);
    expect(chunkHasStaleEntity('a pressure cooker', heads)).toBe(false);
  });

  it('is false for an empty heads list', () => {
    expect(chunkHasStaleEntity('metformin discontinued', [])).toBe(false);
  });
});
