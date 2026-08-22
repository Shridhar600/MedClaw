import { ledgerFactToRecord } from '../../src/indexstore';
import type { LedgerFact } from '../../src/memcore';

function ledgerFact(over: Partial<LedgerFact> = {}): LedgerFact {
  return {
    id: 'metformin@v2',
    profileId: 'default',
    entity: 'metformin',
    type: 'medication',
    version: 2,
    supersedes: 'metformin@v1',
    status: 'active',
    fields: { dose: '850mg', known_side_effects: ['nausea'] },
    provenance: { source: 'doctor', confidence: 0.9, anchor: 'memory/2026-08-12.md#L4', capturedAt: '2026-08-12T00:00:00.000Z' },
    safetyRelevant: true,
    episodeId: 'ep-3',
    language: 'en',
    visibility: 'private',
    createdAt: '2026-08-12T00:00:00.000Z',
    ...over,
  };
}

describe('ledgerFactToRecord (v2-M-2 mapping: LedgerFact -> FactRecord)', () => {
  it('maps provenance.source -> authority and provenance.confidence -> confidence', () => {
    const r = ledgerFactToRecord(ledgerFact());
    expect(r.authority).toBe('doctor');
    expect(r.confidence).toBeCloseTo(0.9, 6);
  });

  it('carries id / entity / type / version / status / supersedes / episodeId / safetyRelevant / fields verbatim', () => {
    const r = ledgerFactToRecord(ledgerFact());
    expect(r).toMatchObject({
      id: 'metformin@v2',
      profileId: 'default',
      entity: 'metformin',
      type: 'medication',
      version: 2,
      status: 'active',
      supersedes: 'metformin@v1',
      episodeId: 'ep-3',
      safetyRelevant: true,
      createdAt: '2026-08-12T00:00:00.000Z',
    });
    expect(r.fields).toEqual({ dose: '850mg', known_side_effects: ['nausea'] });
  });

  it('leaves episodeId undefined when the fact has none', () => {
    const r = ledgerFactToRecord(ledgerFact({ episodeId: undefined }));
    expect(r.episodeId).toBeUndefined();
  });
});
