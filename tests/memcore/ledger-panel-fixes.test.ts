// Regression tests for the Wave A+B hostile-panel findings (reviews/w-ab-panel-*.md).
// Each test reproduces a CONFIRMED bug; it must be RED on the pre-fix code.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LedgerStore } from '../../src/memcore/ledger-store';
import { Provenance } from '../../src/memcore/types';

let tmpDir: string;
let store: LedgerStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-ledger-panel-'));
  store = new LedgerStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const doc: Provenance = { source: 'doctor', confidence: 0.95, anchor: 'a', capturedAt: '' };
const usr: Provenance = { source: 'user', confidence: 1, anchor: 'a', capturedAt: '' };

describe('F1 — confirm() completes for a paused entity (A2 supersession-carry)', () => {
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

describe('F2 — restart cannot produce two active versions', () => {
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
    // the second confirm must NOT create a second active version
    await expect(store.confirm(r2.token.uuid)).rejects.toThrow();

    const chain = await store.getChain('metformin', 'medication');
    expect(chain.filter(f => f.status === 'active')).toHaveLength(1);
    const active = await store.getActive('metformin', 'medication');
    expect(active).not.toBeNull();
  });
});

describe('F3-guard — retract on a missing entity returns a typed noop', () => {
  it('does not return an applied result with a null fact', async () => {
    const r = await store.retract({ entity: 'ghost', type: 'medication', provenance: usr });
    expect(r.kind).toBe('noop');
  });
});

describe('F4 — medications/allergies are safety-relevant by construction', () => {
  it('forces safetyRelevant=true for medication and allergy even when the caller omits it', async () => {
    const med = await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: doc });
    const alg = await store.recordFact({ entity: 'penicillin', type: 'allergy', fields: {}, provenance: doc });
    const cond = await store.recordFact({ entity: 'mild-cold', type: 'condition', fields: {}, provenance: usr });
    if (med.kind === 'applied') expect(med.fact.safetyRelevant).toBe(true);
    if (alg.kind === 'applied') expect(alg.fact.safetyRelevant).toBe(true);
    if (cond.kind === 'applied') expect(cond.fact.safetyRelevant).toBe(false); // non-med not forced
  });
});

describe('F6 — retracting a medication always requires confirmation', () => {
  it('a med recorded without an explicit safetyRelevant flag still needs a token to retract', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: doc });
    const r = await store.retract({ entity: 'metformin', type: 'medication', provenance: usr });
    expect(r.kind).toBe('needs-confirmation'); // was: {kind:'applied'} with no token
  });
});

describe('F3 — corrupt ledger file is quarantined, not silently truncated', () => {
  it('preserves prior bytes in a sidecar before the next write overwrites', async () => {
    fs.mkdirSync(path.join(tmpDir, 'ledger'), { recursive: true });
    const fp = path.join(tmpDir, 'ledger', 'medications.md');
    fs.writeFileSync(fp, '## metformin\n### v1 (activ'); // truncated mid-version-header → parses to []
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await store.recordFact({ entity: 'aspirin', type: 'medication', fields: { dose: '75mg' }, provenance: doc });
      const sidecars = fs.readdirSync(path.join(tmpDir, 'ledger')).filter(n => n.includes('corrupt'));
      expect(sidecars.length).toBe(1);
      expect(fs.readFileSync(path.join(tmpDir, 'ledger', sidecars[0]), 'utf-8')).toContain('metformin');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('F19 — LedgerStore uses an injected clock for token expiry', () => {
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
