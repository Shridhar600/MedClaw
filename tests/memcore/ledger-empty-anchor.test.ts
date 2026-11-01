import { renderLedgerFile, parseLedgerFile } from '../../src/memcore';
import { fact } from '../helpers/memcore-fixtures';

const PARSE_OPTS = { type: 'medication' as const, profileId: 'test-profile' };

describe('ledger round-trip with empty provenance.anchor (data-integrity fix)', () => {
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
    const md = ['## bogus', '### v1 (active)', '- provenance: not a real provenance', '- captured_at: 2026-08-12T00:00:00.000Z'].join('\n');
    const parsed = parseLedgerFile(md, PARSE_OPTS);
    expect(parsed.some(p => p.fields._quarantine !== undefined)).toBe(true);
  });
});
