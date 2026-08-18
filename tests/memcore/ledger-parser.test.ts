import { LedgerFact } from '../../src/memcore/types';
import { parseLedgerFile, renderLedgerFile } from '../../src/memcore/ledger-parser';

function makeFact(overrides: Partial<LedgerFact> & { entity: string; version: number }): LedgerFact {
  return {
    id: `${overrides.entity}@v${overrides.version}`,
    profileId: overrides.profileId || 'test-profile',
    type: overrides.type || 'medication',
    status: overrides.status || 'active',
    fields: overrides.fields || {},
    provenance: overrides.provenance || {
      source: 'doctor',
      confidence: 0.95,
      anchor: 'memory/2026-07-07.md#L14',
      capturedAt: '2026-07-07T10:00:00.000Z',
      note: 'Dr. Mehta visit',
    },
    safetyRelevant: overrides.safetyRelevant ?? false,
    language: overrides.language || 'en',
    visibility: overrides.visibility || 'private',
    createdAt: overrides.createdAt || '2026-07-07T10:00:00.000Z',
    ...overrides,
  };
}

function roundTrip(facts: LedgerFact[]): LedgerFact[] {
  const type = facts[0]?.type || 'medication';
  const md = renderLedgerFile(facts);
  return parseLedgerFile(md, { type, profileId: 'test-profile' });
}

describe('ledger-parser', () => {
  describe('renderLedgerFile', () => {
    it('renders a single active fact', () => {
      const fact = makeFact({ entity: 'metformin', version: 1, fields: { dose: '850mg 1x/day', started: '2026-03-02' } });
      const md = renderLedgerFile([fact]);
      expect(md).toContain('## metformin');
      expect(md).toContain('### v1 (active)');
      expect(md).toContain('- dose: 850mg 1x/day');
      expect(md).toContain('- started: 2026-03-02');
      expect(md).toContain('- provenance: doctor (0.95) · memory/2026-07-07.md#L14 · "Dr. Mehta visit"');
    });

    it('renders multiple versions newest-first', () => {
      const v1 = makeFact({ entity: 'metformin', version: 1, status: 'superseded', createdAt: '2026-03-01T00:00:00.000Z', fields: { dose: '500mg 1x/day' } });
      const v2 = makeFact({ entity: 'metformin', version: 2, status: 'active', createdAt: '2026-07-07T00:00:00.000Z', fields: { dose: '850mg 1x/day' } });
      const md = renderLedgerFile([v1, v2]);
      const v2Idx = md.indexOf('### v2');
      const v1Idx = md.indexOf('### v1');
      expect(v2Idx).toBeLessThan(v1Idx);
    });

    it('renders array fields', () => {
      const fact = makeFact({ entity: 'metformin', version: 1, fields: { side_effects: ['nausea', 'headache'] as string[] } });
      const md = renderLedgerFile([fact]);
      expect(md).toContain('- side_effects: [nausea, headache]');
    });

    it('renders verbatim in quotes', () => {
      const fact = makeFact({ entity: 'metformin', version: 1, verbatim: 'Dr. Mehta increased to 850' });
      const md = renderLedgerFile([fact]);
      expect(md).toContain('- verbatim: "Dr. Mehta increased to 850"');
    });
  });

  describe('parseLedgerFile', () => {
    it('parses a rendered file', () => {
      const facts = [makeFact({ entity: 'metformin', version: 1, fields: { dose: '850mg 1x/day' } })];
      const md = renderLedgerFile(facts);
      const parsed = parseLedgerFile(md, { type: 'medication', profileId: 'test' });
      expect(parsed).toHaveLength(1);
      expect(parsed[0].entity).toBe('metformin');
      expect(parsed[0].version).toBe(1);
    });

    it('returns empty array for empty input', () => {
      const parsed = parseLedgerFile('', { type: 'medication', profileId: 'test' });
      expect(parsed).toEqual([]);
    });

    it('returns empty array for input without ## headers', () => {
      const parsed = parseLedgerFile('# Some random markdown\n\nnot a ledger file', { type: 'medication', profileId: 'test' });
      expect(parsed).toEqual([]);
    });

    it('handles corrupt block with PARSE-ERROR quarantine and still parses other entities', () => {
      const md = `## metformin
### v2 (active)
- dose: 850mg 1x/day
- provenance: doctor (0.95) · memory/2026-07-07.md#L14

## broken
### v1 (active)
this is garbage that should not parse
- incomplete: no value

## ibuprofen
### v1 (active)
- dose: 200mg as needed
- provenance: user (1.00) · memory/2026-07-07.md#L15
`;
      const parsed = parseLedgerFile(md, { type: 'medication', profileId: 'test' });
      expect(parsed.length).toBeGreaterThanOrEqual(2);
      const goodFacts = parsed.filter(f => f.fields._quarantine === undefined);
      expect(goodFacts.length).toBeGreaterThanOrEqual(2);
      expect(parsed.some(f => f.entity === 'metformin')).toBe(true);
      expect(parsed.some(f => f.entity === 'ibuprofen')).toBe(true);
    });

    it('parses provenance note in quotes', () => {
      const fact = makeFact({ entity: 'metformin', version: 1 });
      const md = renderLedgerFile([fact]);
      const parsed = parseLedgerFile(md, { type: 'medication', profileId: 'test' });
      expect(parsed[0].provenance.note).toBe('Dr. Mehta visit');
    });

    it('parses safety_relevant and language from combined line', () => {
      const fact = makeFact({
        entity: 'metformin',
        version: 1,
        safetyRelevant: true,
        language: 'en',
        episodeId: '2026-03-diabetes',
      });
      const md = renderLedgerFile([fact]);
      expect(md).toContain('safety_relevant: true');
      expect(md).toContain('episode: 2026-03-diabetes');
      const parsed = parseLedgerFile(md, { type: 'medication', profileId: 'test' });
      expect(parsed[0].safetyRelevant).toBe(true);
      expect(parsed[0].language).toBe('en');
      expect(parsed[0].episodeId).toBe('2026-03-diabetes');
    });

    it('parses array values', () => {
      const md = `## metformin
### v1 (active)
- dose: 850mg 1x/day
- side_effects: [nausea, b12-deficiency]
- provenance: user (1.00) · memory/test.md#L1
`;
      const parsed = parseLedgerFile(md, { type: 'medication', profileId: 'test' });
      expect(parsed).toHaveLength(1);
      expect(parsed[0].fields.side_effects).toEqual(['nausea', 'b12-deficiency']);
    });

    it('parses numeric values', () => {
      const md = `## metformin
### v1 (active)
- dose: 500
- provenance: user (1.00) · memory/test.md#L1
`;
      const parsed = parseLedgerFile(md, { type: 'medication', profileId: 'test' });
      expect(parsed[0].fields.dose).toBe(500);
    });
  });

  describe('round-trip', () => {
    it('preserves fields through parse(render())', () => {
      const facts = [
        makeFact({
          entity: 'metformin',
          version: 1,
          fields: { dose: '850mg 1x/day', started: '2026-03-02', max_daily: 2 },
        }),
      ];
      const parsed = roundTrip(facts);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].fields.dose).toBe('850mg 1x/day');
      expect(parsed[0].fields.started).toBe('2026-03-02');
    });

    it('preserves unknown keys in fields', () => {
      const facts = [
        makeFact({
          entity: 'metformin',
          version: 1,
          fields: { custom_field: 'custom_value', unknown_num: 42 },
        }),
      ];
      const parsed = roundTrip(facts);
      expect(parsed[0].fields.custom_field).toBe('custom_value');
    });

    it('preserves verbatim with language tags', () => {
      const facts = [
        makeFact({
          entity: 'knee-pain',
          version: 1,
          verbatim: 'My knee hurts when I climb stairs',
          language: 'en',
        }),
      ];
      const parsed = roundTrip(facts);
      expect(parsed[0].verbatim).toBe('My knee hurts when I climb stairs');
      expect(parsed[0].language).toBe('en');
    });

    it('preserves array fields through round-trip', () => {
      const facts = [
        makeFact({
          entity: 'metformin',
          version: 1,
          fields: { known_side_effects: ['nausea', 'b12-deficiency'] as string[] },
        }),
      ];
      const parsed = roundTrip(facts);
      expect(parsed[0].fields.known_side_effects).toEqual(['nausea', 'b12-deficiency']);
    });

    it('preserves status, supersedes, supersededBy', () => {
      const facts = [
        makeFact({ entity: 'metformin', version: 2, status: 'active', fields: { dose: '850mg' }, supersedes: 'metformin@v1' }),
        makeFact({ entity: 'metformin', version: 1, status: 'superseded', fields: { dose: '500mg' }, createdAt: '2026-03-01T00:00:00.000Z' }),
      ];
      const parsed = roundTrip(facts);
      const v2 = parsed.find(f => f.version === 2)!;
      expect(v2.status).toBe('active');
      expect(v2.supersedes).toBe('metformin@v1');
    });

    it('preserves created_at through round-trip', () => {
      const facts = [
        makeFact({ entity: 'metformin', version: 1, createdAt: '2026-07-07T10:00:00.000Z' }),
      ];
      const parsed = roundTrip(facts);
      expect(parsed[0].createdAt).toBe('2026-07-07T10:00:00.000Z');
    });

    it('preserves provenance note through round-trip', () => {
      const facts = [
        makeFact({ entity: 'metformin', version: 1, provenance: { source: 'doctor', confidence: 0.95, anchor: 'memory/visit.md#L14', capturedAt: '2026-07-07T10:00:00.000Z', note: 'Dr. Mehta increased to 850' } }),
      ];
      const parsed = roundTrip(facts);
      expect(parsed[0].provenance.note).toBe('Dr. Mehta increased to 850');
      expect(parsed[0].provenance.source).toBe('doctor');
    });

    it('handles multiple entities in round-trip', () => {
      const facts = [
        makeFact({ entity: 'metformin', version: 1, fields: { dose: '850mg' } }),
        makeFact({ entity: 'lisinopril', version: 1, fields: { dose: '10mg' }, type: 'medication' }),
      ];
      const parsed = roundTrip(facts);
      expect(parsed).toHaveLength(2);
      expect(parsed.some(f => f.entity === 'metformin')).toBe(true);
      expect(parsed.some(f => f.entity === 'lisinopril')).toBe(true);
    });

    it('preserves visibility field', () => {
      const facts = [
        makeFact({ entity: 'metformin', version: 1, visibility: 'shareable-summary' }),
      ];
      const parsed = roundTrip(facts);
      expect(parsed[0].visibility).toBe('shareable-summary');
    });
  });

  describe('cross-entity + discontinue round-trip (Task 3)', () => {
    it('round-trips replaces/replacedBy/corrects/correctedBy/discontinuedReason as top-level fields', () => {
      const f = makeFact({
        entity: 'naproxen', version: 2, status: 'discontinued',
        replaces: 'ibuprofen@v1', replacedBy: 'aspirin@v1',
        corrects: 'ibuprofen@v1', correctedBy: 'aspirin@v1',
        discontinuedReason: 'doctor-discontinued',
      });
      const [parsed] = roundTrip([f]);
      expect(parsed.replaces).toBe('ibuprofen@v1');
      expect(parsed.replacedBy).toBe('aspirin@v1');
      expect(parsed.corrects).toBe('ibuprofen@v1');
      expect(parsed.correctedBy).toBe('aspirin@v1');
      expect(parsed.discontinuedReason).toBe('doctor-discontinued');
    });
  });
});
