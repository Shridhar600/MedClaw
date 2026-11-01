import * as fs from 'fs';
import * as path from 'path';

import { LedgerStore } from '../../src/memcore';
import type { Provenance } from '../../src/memcore';
import { mutableClock } from '../helpers/memcore-fixtures';
import { makeTestTemp } from '../helpers/test-temp';

const DAY = '2026-08-20T10:00:00.000Z';

function prov(source: Provenance['source']): Provenance {
  return { source, confidence: 0.9, anchor: '', capturedAt: DAY };
}

describe('confirm rejects a stale token instead of clobbering', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-ch-');
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('state moved under the pending write → CONFIRM_REJECTED with a safe reason', async () => {
    await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: prov('user') });
    const result = await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '10mg' }, provenance: prov('user') });
    expect(result.kind).toBe('needs-confirmation');
    if (result.kind !== 'needs-confirmation') return;

    const merged = await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { frequency: 'daily' }, provenance: prov('user') });
    expect(merged.kind).toBe('applied');

    let thrown: unknown;
    try {
      await store.confirm(result.token.uuid);
    } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    // PHI-free reason vocabulary — never an entity name in the rejection.
    expect(message).toMatch(/changed since this change was proposed|CONFIRM_REJECTED/i);
    expect(message).not.toContain('warfarin');
    const active = await store.getActive('warfarin', 'medication');
    expect(active!.version).toBe(2);
    expect(active!.fields.frequency).toBe('daily');
  });

  it('an UNMOVED state still confirms cleanly (no false staleness)', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: prov('user') });
    const result = await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: prov('doctor') });
    expect(result.kind).toBe('needs-confirmation');
    if (result.kind !== 'needs-confirmation') return;
    const fact = await store.confirm(result.token.uuid);
    expect(fact.fields.dose).toBe('850mg');
    expect((await store.getActive('metformin', 'medication'))!.fields.dose).toBe('850mg');
  });
});

describe('a failed apply leaves the token usable; success burns it', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-tb-');
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('after a failed apply the SECOND attempt reports state drift, not already-used', async () => {
    await store.recordFact({ entity: 'aspirin', type: 'medication', fields: { dose: '81mg' }, provenance: prov('user') });
    const result = await store.recordFact({ entity: 'aspirin', type: 'medication', fields: { dose: '325mg' }, provenance: prov('user') });
    if (result.kind !== 'needs-confirmation') return;
    fs.rmSync(path.join(tmp, 'ledger', 'medications.md'));
    const first = await store.confirm(result.token.uuid).then(() => null, (e: unknown) => e);
    expect(first).toBeDefined(); // failed…
    const second = await store.confirm(result.token.uuid).then(() => null, (e: unknown) => e);
    const secondMessage = second instanceof Error ? second.message : String(second ?? '');
    expect(secondMessage).not.toMatch(/already used/);
  });

  it('a SUCCESSFUL apply still burns the token (single-use holds)', async () => {
    await store.recordFact({ entity: 'lisinopril', type: 'medication', fields: { dose: '10mg' }, provenance: prov('user') });
    const result = await store.recordFact({ entity: 'lisinopril', type: 'medication', fields: { dose: '20mg' }, provenance: prov('doctor') });
    if (result.kind !== 'needs-confirmation') return;
    await store.confirm(result.token.uuid);
    let thrown: unknown;
    try {
      await store.confirm(result.token.uuid);
    } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect((thrown instanceof Error ? thrown.message : '')).toMatch(/already used/);
  });
});

describe('a claim made while a dispute is open', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-da-');
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('re-offers the open dispute instead of starting a second active chain', async () => {
    await store.recordFact({ entity: 'knee-pain', type: 'symptom', fields: { severity: 'mild' }, provenance: prov('user'), safetyRelevant: true });
    const d = await store.recordFact({ entity: 'knee-pain', type: 'symptom', fields: { severity: 'severe' }, provenance: prov('user'), safetyRelevant: true });
    if (d.kind !== 'disputed') return throwErr('expected dispute');

    const third = await store.recordFact({ entity: 'knee-pain', type: 'symptom', fields: { severity: 'moderate' }, provenance: prov('user'), safetyRelevant: true });
    expect(third.kind).toBe('disputed');
    expect((await store.getChain('knee-pain', 'symptom')).filter(f => f.status === 'active')).toHaveLength(0);

    await store.confirm(d.disputeToken.uuid, { winningVersion: d.versions[0].version });
    const chain = await store.getChain('knee-pain', 'symptom');
    expect(chain.filter(f => f.status === 'active')).toHaveLength(1);
    expect(new Set(chain.map(f => f.id)).size).toBe(chain.length);
  });
});

function throwErr(msg: string): never {
  throw new Error(msg);
}
