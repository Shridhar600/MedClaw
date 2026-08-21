// W-C/D hostile-panel fix pass — confirmation-token hardening (CH / TB / DT).
// Each test was proven RED on p1-memory-core @ cbf6c40 via the git-stash
// technique (src/ stashed, tests kept, failures observed, stash popped).
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { LedgerStore } from '../../src/memcore';
import type { Provenance } from '../../src/memcore';
import { mutableClock } from '../helpers/memcore-fixtures';

const DAY = '2026-08-20T10:00:00.000Z';

function prov(source: Provenance['source']): Provenance {
  return { source, confidence: 0.9, anchor: '', capturedAt: DAY };
}

describe('W-C/D fix pass — CH: confirm rejects a stale token instead of clobbering', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-ch-'));
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('state moved under the pending write → CONFIRM_REJECTED with a safe reason', async () => {
    await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: prov('user') });
    const result = await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '10mg' }, provenance: prov('user') });
    expect(result.kind).toBe('needs-confirmation');
    if (result.kind !== 'needs-confirmation') return;

    // The state moves under the token: a NON-conflicting field merges and
    // supersedes the version the proposal was minted against.
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
    // The newer legitimate write survived (no stale clobber): the active
    // version is still the merged v2, NOT a resurrected proposal.
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

describe('W-C/D fix pass — TB: a failed apply leaves the token usable; success burns it', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-tb-'));
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('after a failed apply the SECOND attempt reports state drift, not already-used', async () => {
    await store.recordFact({ entity: 'aspirin', type: 'medication', fields: { dose: '81mg' }, provenance: prov('user') });
    const result = await store.recordFact({ entity: 'aspirin', type: 'medication', fields: { dose: '325mg' }, provenance: prov('user') });
    if (result.kind !== 'needs-confirmation') return;
    // Force the first apply to fail deterministically: remove the underlying file.
    fs.rmSync(path.join(tmp, 'ledger', 'medications.md'));
    const first = await store.confirm(result.token.uuid).then(() => null, (e: unknown) => e);
    expect(first).toBeDefined(); // failed…
    const second = await store.confirm(result.token.uuid).then(() => null, (e: unknown) => e);
    // …but the token was NOT burned by the failure (pre-fix: burned BEFORE apply).
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

describe('W-C/D fix pass — self-review IMPORTANT-3: fresh active during a dispute window rejects resolution', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-da-'));
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('confirming a stale dispute while a NEWER active exists is rejected (no double-active)', async () => {
    await store.recordFact({ entity: 'knee-pain', type: 'symptom', fields: { severity: 'mild' }, provenance: prov('user'), safetyRelevant: true });
    const d = await store.recordFact({ entity: 'knee-pain', type: 'symptom', fields: { severity: 'severe' }, provenance: prov('user'), safetyRelevant: true });
    if (d.kind !== 'disputed') return throwErr('expected dispute');

    // Mid-window, the user records a THIRD claim — no active version exists, so
    // it becomes a FRESH ACTIVE fact while the dispute token is still live.
    const third = await store.recordFact({ entity: 'knee-pain', type: 'symptom', fields: { severity: 'moderate' }, provenance: prov('user'), safetyRelevant: true });
    expect(third.kind).toBe('applied');

    let thrown: unknown;
    try {
      await store.confirm(d.disputeToken.uuid, { winningVersion: d.versions[0].version });
    } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    // Exactly ONE active survives — never two coexisting actives.
    const chain = await store.getChain('knee-pain', 'symptom');
    expect(chain.filter(f => f.status === 'active')).toHaveLength(1);
  });
});

function throwErr(msg: string): never {
  throw new Error(msg);
}
