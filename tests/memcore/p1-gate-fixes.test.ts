// P1 gate-closer fix pass — store-level regressions (audit SB-2, H-1, M-5, M-4).
// Each was proven RED on p1-memory-core @ 941078d before its fix landed.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { LedgerStore, EpisodeStore } from '../../src/memcore';
import type { Provenance } from '../../src/memcore';
import { mutableClock } from '../helpers/memcore-fixtures';

const DAY = '2026-08-22T10:00:00.000Z';
function prov(source: Provenance['source'], capturedAt: string = DAY): Provenance {
  return { source, confidence: 0.9, anchor: '', capturedAt };
}

describe('P1 gate fix — SB-2: version heads MERGE fields, never silently drop carried fields', () => {
  let tmp: string;
  let store: LedgerStore;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sb2-')); store = new LedgerStore(tmp, mutableClock(DAY)); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('a non-conflicting field add preserves the prior fields on the new active head', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg', known_side_effects: ['nausea'] }, provenance: prov('user') });
    const r = await store.recordFact({ entity: 'metformin', type: 'medication', fields: { food: 'with meals' }, provenance: prov('user') });
    expect(r.kind).toBe('applied');
    const active = (await store.getActive('metformin', 'medication'))!;
    expect(active.fields.dose).toBe('850mg');                       // was dropped pre-fix
    expect(active.fields.known_side_effects).toEqual(['nausea']);   // was dropped pre-fix
    expect(active.fields.food).toBe('with meals');
  });

  it('a confirmed dose change preserves known_side_effects on the new active head (DIAB-05 substrate)', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg', known_side_effects: ['nausea', 'b12-deficiency'] }, provenance: prov('user') });
    const change = await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '1000mg' }, provenance: prov('doctor') });
    expect(change.kind).toBe('needs-confirmation');
    if (change.kind === 'needs-confirmation') await store.confirm(change.token.uuid);
    const active = (await store.getActive('metformin', 'medication'))!;
    expect(active.fields.dose).toBe('1000mg');
    expect(active.fields.known_side_effects).toEqual(['nausea', 'b12-deficiency']); // vanished pre-fix
  });
});

describe('P1 gate fix — H-1: resume never bypasses the med/allergy confirmation gate', () => {
  let tmp: string;
  let store: LedgerStore;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-h1-')); store = new LedgerStore(tmp, mutableClock(DAY)); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('resuming a paused MEDICATION requires confirmation', async () => {
    await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: prov('user') });
    await store.pause('warfarin', 'medication', prov('user'), { prePauseSummary: 'held during travel' });
    const r = await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: prov('user'), resume: true });
    expect(r.kind).toBe('needs-confirmation'); // applied instantly pre-fix
  });

  it('resuming a paused NON-med still applies instantly (no over-block)', async () => {
    await store.recordFact({ entity: 'gym-goal', type: 'goal', fields: { target: '3x/week' }, provenance: prov('user') });
    await store.pause('gym-goal', 'goal', prov('user'), { prePauseSummary: 'travel' });
    const g = await store.recordFact({ entity: 'gym-goal', type: 'goal', fields: { target: '3x/week' }, provenance: prov('user'), resume: true });
    expect(g.kind).toBe('applied');
  });
});

describe('P1 gate fix — M-5: quarantine sentinels never surface as active facts', () => {
  let tmp: string;
  let store: LedgerStore;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-m5-')); store = new LedgerStore(tmp, mutableClock(DAY)); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('a v0 parse-error sentinel (provenance-less block) is excluded from getActive/listByType', async () => {
    fs.mkdirSync(path.join(tmp, 'ledger'), { recursive: true });
    // A version block with NO `- provenance:` line makes the parser fail-loud → a v0 quarantine sentinel.
    fs.writeFileSync(path.join(tmp, 'ledger', 'medications.md'), '## ghostmed\n### v1 (active)\n- dose: 500mg\n');
    expect(await store.getActive('ghostmed', 'medication')).toBeNull();                       // returned the sentinel pre-fix
    expect((await store.listByType('medication')).some(f => f.entity === 'ghostmed')).toBe(false);
  });
});

describe('P1 gate fix — M-4: episode array elements cannot forge metadata on round-trip', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-m4-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('a bodyRegion carrying newline+meta does not forge episode status', async () => {
    const es = new EpisodeStore(tmp);
    const created = await es.create({ title: 'Knee arc', profileId: 'default', status: 'open', bodyRegions: ['left knee\n- status: resolved\n- pad: x'] });
    const reread = await es.get(created.id);
    expect(reread?.status).toBe('open'); // pre-fix: forged/corrupted (null or 'resolved')
  });
});
