import { renderLedgerFile, parseLedgerFile } from '../../src/memcore';
import { fact } from '../helpers/memcore-fixtures';

// Wave C regression: a fact may legitimately carry an empty provenance.anchor (e.g. a
// caller records a fact before its narrative anchor is known). The renderer emits a
// trailing `· ` that the reader trims to `·`, which the split-on-` · ` provenance parse
// then rejected — silently quarantining the block and fabricating a v0 "active" fact on
// each subsequent read. The round-trip must survive an empty anchor without quarantine.
const PARSE_OPTS = { type: 'medication' as const, profileId: 'test-profile' };

describe('ledger round-trip with empty provenance.anchor (Wave C data-integrity fix)', () => {
  it('a fact with an empty anchor survives render -> parse without quarantine', () => {
    const f = fact('metformin', 'medication', { version: 1, status: 'active' });
    f.provenance.anchor = '';

    const parsed = parseLedgerFile(renderLedgerFile([f]), PARSE_OPTS);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].entity).toBe('metformin');
    expect(parsed[0].status).toBe('active');
    expect(parsed[0].version).toBe(1);
    expect(parsed[0].provenance.anchor).toBe('');
    expect(parsed[0].fields._quarantine).toBeUndefined();
  });

  it('a non-empty anchor still round-trips exactly', () => {
    const f = fact('lisinopril', 'medication', { version: 1, status: 'active' });
    f.provenance.anchor = 'memory/2026-08-12.md#L5';

    const parsed = parseLedgerFile(renderLedgerFile([f]), PARSE_OPTS);

    expect(parsed[0].provenance.anchor).toBe('memory/2026-08-12.md#L5');
    expect(parsed[0].fields._quarantine).toBeUndefined();
  });

  it('preserves a provenance note alongside an empty anchor', () => {
    const f = fact('warfarin', 'medication', { version: 1, status: 'active' });
    f.provenance.anchor = '';
    f.provenance.note = 'per cardiologist';

    const parsed = parseLedgerFile(renderLedgerFile([f]), PARSE_OPTS);

    expect(parsed[0].provenance.note).toBe('per cardiologist');
    expect(parsed[0].provenance.anchor).toBe('');
    expect(parsed[0].fields._quarantine).toBeUndefined();
  });

  it('still quarantines a genuinely malformed provenance line', () => {
    // A provenance line with no source/confidence must still fail loud (no fabrication).
    const md = ['## bogus', '### v1 (active)', '- provenance: not a real provenance', '- captured_at: 2026-08-12T00:00:00.000Z'].join('\n');
    const parsed = parseLedgerFile(md, PARSE_OPTS);
    // The block is quarantined rather than silently accepted as a real fact.
    expect(parsed.some(p => p.fields._quarantine !== undefined)).toBe(true);
  });
});
