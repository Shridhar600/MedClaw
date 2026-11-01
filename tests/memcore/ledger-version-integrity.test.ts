import * as fs from 'fs';
import * as path from 'path';
import { LedgerStore } from '../../src/memcore/ledger-store';
import { Provenance } from '../../src/memcore/types';
import { makeTestTemp } from '../helpers/test-temp';

let tmpDir: string;
let store: LedgerStore;

beforeEach(() => {
  tmpDir = makeTestTemp('redacted-ledger-');
  store = new LedgerStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const doc: Provenance = { source: 'doctor', confidence: 0.95, anchor: 'a', capturedAt: '' };
const usr: Provenance = { source: 'user', confidence: 1, anchor: 'a', capturedAt: '' };

describe('confirm completes for a paused entity (supersession-carry)', () => {
  it('confirm on a paused-entity write applies (no "no active version" rejection)', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: doc });
    await store.pause('metformin', 'medication', doc, { prePauseSummary: 'held for surgery' });
    const r = await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: doc });
    expect(r.kind).toBe('needs-confirmation');
    if (r.kind !== 'needs-confirmation') return;

    const fact = await store.confirm(r.token.uuid); // was: throws CONFIRM_REJECTED: no active version
    expect(fact.status).toBe('paused');
    expect(fact.fields.pre_pause_summary).toBe('held for surgery');
    expect(fact.fields.dose).toBe('500mg');
  });
});

describe('restart cannot produce two active versions', () => {
  it('confirming two restart tokens leaves exactly one active version', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: doc });
    const d = await store.discontinue('metformin', 'medication', doc);
    if (d.kind === 'needs-confirmation') await store.confirm(d.token.uuid);

    const r1 = await store.restart('metformin', 'medication', doc, { dose: '500mg' });
    const r2 = await store.restart('metformin', 'medication', doc, { dose: '250mg' });
    expect(r1.kind).toBe('needs-confirmation');
    expect(r2.kind).toBe('needs-confirmation');
    if (r1.kind !== 'needs-confirmation' || r2.kind !== 'needs-confirmation') return;

    await store.confirm(r1.token.uuid);
    await expect(store.confirm(r2.token.uuid)).rejects.toThrow();

    const chain = await store.getChain('metformin', 'medication');
    expect(chain.filter(f => f.status === 'active')).toHaveLength(1);
    const active = await store.getActive('metformin', 'medication');
    expect(active).not.toBeNull();
  });
});

describe('guard — retract on a missing entity returns a typed noop', () => {
  it('does not return an applied result with a null fact', async () => {
    const r = await store.retract({ entity: 'ghost', type: 'medication', provenance: usr });
    expect(r.kind).toBe('noop');
  });
});

describe('medications/allergies are safety-relevant by construction', () => {
  it('forces safetyRelevant=true for medication and allergy even when the caller omits it', async () => {
    const med = await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: doc });
    const alg = await store.recordFact({ entity: 'penicillin', type: 'allergy', fields: {}, provenance: doc });
    const cond = await store.recordFact({ entity: 'mild-cold', type: 'condition', fields: {}, provenance: usr });
    if (med.kind === 'applied') expect(med.fact.safetyRelevant).toBe(true);
    if (alg.kind === 'applied') expect(alg.fact.safetyRelevant).toBe(true);
    if (cond.kind === 'applied') expect(cond.fact.safetyRelevant).toBe(false); // non-med not forced
  });
});

describe('retracting a medication always requires confirmation', () => {
  it('a med recorded without an explicit safetyRelevant flag still needs a token to retract', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: doc });
    const r = await store.retract({ entity: 'metformin', type: 'medication', provenance: usr });
    expect(r.kind).toBe('needs-confirmation'); // was: {kind:'applied'} with no token
  });
});

describe('a damaged ledger file is preserved and read-only until repaired', () => {
  it('keeps the damaged bytes, refuses changes, and accepts them again once the file is fixed', async () => {
    fs.mkdirSync(path.join(tmpDir, 'ledger'), { recursive: true });
    const fp = path.join(tmpDir, 'ledger', 'medications.md');
    const corrupt = Buffer.from([
      '## metformin\n',
      '### v1 (active)\n',
      '- dose 999mg\n',
      '- provenance: doctor (99.00) · memory/visit.md#L1\n',
    ].join(''));
    fs.writeFileSync(fp, corrupt);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(store.recordFact({ entity: 'aspirin', type: 'medication', fields: { dose: '75mg' }, provenance: doc }))
          .rejects.toThrow(/damaged/);
      }
      expect(fs.readFileSync(fp)).toEqual(corrupt);
      const sidecars = fs.readdirSync(path.join(tmpDir, 'ledger')).filter(n => n.includes('corrupt'));
      expect(sidecars).toHaveLength(1);
      expect(fs.readFileSync(path.join(tmpDir, 'ledger', sidecars[0]))).toEqual(corrupt);
      expect(store.damagedFiles()).toEqual(['medications.md']);

      fs.writeFileSync(fp, '');
      const repaired = await store.recordFact({ entity: 'aspirin', type: 'medication', fields: { dose: '75mg' }, provenance: doc });
      expect(repaired.kind).toBe('applied');
      expect(store.damagedFiles()).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('entity slugs are validated before an id is created', () => {
  it('rejects a newline-bearing entity at the store boundary', async () => {
    await expect(store.recordFact({
      entity: 'metformin\n## forged',
      type: 'medication',
      fields: { dose: '500mg' },
      provenance: doc,
    })).rejects.toThrow('invalid-entity-slug');

    expect(fs.existsSync(path.join(tmpDir, 'ledger', 'medications.md'))).toBe(false);
  });
});

describe('LedgerStore uses an injected clock for token expiry', () => {
  it('rejects a confirmation token after the injected clock passes its expiry', async () => {
    const clock = { nowMs: Date.parse('2026-08-18T00:00:00.000Z'), now(): Date { return new Date(this.nowMs); } };
    const s = new LedgerStore(tmpDir, clock);
    await s.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: doc, safetyRelevant: true });
    const r = await s.retract({ entity: 'metformin', type: 'medication', provenance: doc });
    expect(r.kind).toBe('needs-confirmation');
    if (r.kind !== 'needs-confirmation' || !r.token) return;
    clock.nowMs += 16 * 60 * 1000; // 16 min later — past the 15-min token window
    await expect(s.confirm(r.token.uuid)).rejects.toThrow(/expired/i);
  });
});
