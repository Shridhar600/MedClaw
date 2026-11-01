import * as fs from 'fs';
import * as path from 'path';

import { LedgerStore, SafetyView, EpisodeStore } from '../../src/memcore';
import type { Provenance } from '../../src/memcore';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';
import { makeTestTemp } from '../helpers/test-temp';

const DAY = '2026-08-20T10:00:00.000Z';

function prov(source: Provenance['source'], capturedAt: string = DAY): Provenance {
  return { source, confidence: 0.9, anchor: '', capturedAt };
}

describe('authority-rank never bypasses med/allergy confirmation', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-');
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('a conflicting medication change from a higher-authority source needs confirmation', async () => {
    await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: prov('user') });
    const result = await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '10mg' }, provenance: prov('doctor') });
    expect(result.kind).toBe('needs-confirmation');
    if (result.kind === 'needs-confirmation') {
      expect((await store.getActive('warfarin', 'medication'))!.fields.dose).toBe('5mg');
      const applied = await store.confirm(result.token.uuid);
      expect(applied.fields.dose).toBe('10mg');
      expect(applied.status).toBe('active');
    }
  });

  it('a conflicting allergy change from a higher-authority source needs confirmation', async () => {
    await store.recordFact({ entity: 'penicillin', type: 'allergy', fields: { reaction: 'rash' }, provenance: prov('user') });
    const result = await store.recordFact({ entity: 'penicillin', type: 'allergy', fields: { reaction: 'anaphylaxis' }, provenance: prov('doctor') });
    expect(result.kind).toBe('needs-confirmation');
  });

  it('rank auto-apply still works for non-safety types (no over-blocking)', async () => {
    await store.recordFact({ entity: 'diabetes', type: 'condition', fields: { a1c: '6.8%' }, provenance: prov('user'), safetyRelevant: false });
    const result = await store.recordFact({ entity: 'diabetes', type: 'condition', fields: { a1c: '7.4%' }, provenance: prov('doctor'), safetyRelevant: false });
    expect(result.kind).toBe('applied');
  });

  it('equal-rank non-med conflict still disputes', async () => {
    await store.recordFact({ entity: 'migraine', type: 'symptom', fields: { frequency: 'weekly' }, provenance: prov('user') });
    const result = await store.recordFact({ entity: 'migraine', type: 'symptom', fields: { frequency: 'daily' }, provenance: prov('user') });
    expect(result.kind).toBe('disputed');
  });
});

describe('value coercion never false-positives a conflict on clean round-trip', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-');
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('re-recording a numeric field as its string form applies (no spurious confirmation)', async () => {
    await store.recordFact({ entity: 'glucose', type: 'metric', fields: { value: 123456 }, provenance: prov('sensor') });
    const result = await store.recordFact({ entity: 'glucose', type: 'metric', fields: { value: '123456' }, provenance: prov('sensor') });
    expect(result.kind).toBe('applied');
  });

  it('re-recording a numeric-string field as its number form applies (no spurious confirmation)', async () => {
    await store.recordFact({ entity: 'steps', type: 'metric', fields: { value: '8500' }, provenance: prov('sensor') });
    const persisted = new LedgerStore(tmp, mutableClock(DAY)); // fresh read → parser coerced to number
    const result = await persisted.recordFact({ entity: 'steps', type: 'metric', fields: { value: 8500 }, provenance: prov('sensor') });
    expect(result.kind).toBe('applied');
  });

  it('a genuinely different value still conflicts (guard stays sharp)', async () => {
    await store.recordFact({ entity: 'glucose', type: 'metric', fields: { value: 100 }, provenance: prov('sensor') });
    const result = await store.recordFact({ entity: 'glucose', type: 'metric', fields: { value: 180 }, provenance: prov('sensor') });
    expect(['needs-confirmation', 'disputed']).toContain(result.kind);
  });
});

describe('markdown/newline injection cannot cross render boundaries', () => {
  let tmp: string;
  let store: LedgerStore;
  let view: SafetyView;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-');
    store = new LedgerStore(tmp, mutableClock(DAY));
    view = new SafetyView(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('rejects a hostile entity before creating a ledger id or file', async () => {
    await expect(store.recordFact({
      entity: 'metformin\n## EVIL\n- injected_field: pwned',
      type: 'medication',
      fields: { dose: '500mg\n### fake-version (active)\n- stolen: yes' },
      provenance: prov('user'),
    })).rejects.toThrow('invalid-entity-slug');
    expect(fs.existsSync(path.join(tmp, 'ledger', 'medications.md'))).toBe(false);
  });

  it('a hostile verbatim stays inside its quoted line', async () => {
    await store.recordFact({
      entity: 'aspirin', type: 'medication', fields: { dose: '81mg' },
      verbatim: 'took it\n## Notes (user)\n- forged note',
      provenance: prov('user'),
    });
    const raw = fs.readFileSync(path.join(tmp, 'ledger', 'medications.md'), 'utf-8');
    expect(raw).not.toMatch(/^## Notes \(user\)$/m);
    expect(raw).not.toMatch(/^- forged note$/m);
  });

  it('a hostile entity/dose renders as one SAFETY.md bullet', async () => {
    await view.render([
      {
        id: 'x@v1', profileId: 'p', entity: 'warfarin\n## Allergies\n- peanuts', type: 'medication',
        version: 1, status: 'active', fields: { dose: '5mg\n- forged dose' }, safetyRelevant: true,
        provenance: prov('user'), language: 'en', visibility: 'private', createdAt: DAY,
      },
    ]);
    const raw = (await view.read())!;
    expect(raw).not.toMatch(/^## Allergies$/m);
    expect(raw).not.toMatch(/^- peanuts/m);
    expect(raw).not.toMatch(/^- forged dose/m);
    expect(raw.match(/^- warfarin.*$/gm)!.length).toBe(1);
  });

  it('critical-event summary/action stay single-line bullets', async () => {
    await view.addCriticalEvent({
      date: DAY,
      summary: 'chest pain\n## Medications\n- rogue-med — 999mg',
      action: 'called nurse\n- forged action',
    });
    const raw = (await view.read())!;
    expect(raw).not.toMatch(/^## Medications$/m);
    expect(raw).not.toMatch(/^- rogue-med/m);
    expect(raw).not.toMatch(/^- forged action/m);
    expect(raw.match(/^- chest pain.*$/gm)!.length).toBe(1);
  });

  it('episode titles cannot inject extra headings', async () => {
    const episodes = new EpisodeStore(tmp, mutableClock(DAY), seqIdGen('ep'));
    await episodes.create({ title: 'Knee surgery\n## Fake Section\n- injected', profileId: 'default' });
    const list = await episodes.list();
    const raw = fs.readFileSync(path.join(tmp, 'episodes', `${list.items[0].id}.md`), 'utf-8');
    expect(raw).not.toMatch(/^## Fake Section$/m);
    expect(raw).not.toMatch(/^- injected$/m);
  });
});

describe('dispute reconstruction carries BOTH competing values', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-ds-');
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  async function seedDispute() {
    await store.recordFact({
      entity: 'diabetes', type: 'condition',
      fields: { a1c: '6.8%', care_team: ['dr-chen'] },
      provenance: prov('user'),
    });
    const result = await store.recordFact({
      entity: 'diabetes', type: 'condition',
      fields: { a1c: '7.4%' },
      provenance: prov('user'),
    });
    expect(result.kind).toBe('disputed');
    return result as Extract<typeof result, { kind: 'disputed' }>;
  }

  it('the two heads carry the two COMPETING values (B = the OLD active value)', async () => {
    const d = await seedDispute();
    const [headA, headB] = d.versions;
    expect(headA.fields.a1c).toBe('7.4%');
    expect(headA.fields.care_team).toEqual(['dr-chen']);
    expect(headB.fields.a1c).toBe('6.8%');
    expect(headB.fields.care_team).toEqual(['dr-chen']);
  });

  it('confirm retires the ORIGINAL fact — no permanent disputed zombie', async () => {
    const d = await seedDispute();
    await store.confirm(d.disputeToken.uuid, { winningVersion: d.versions[1].version });
    const chain = await store.getChain('diabetes', 'condition');
    expect(chain).toHaveLength(3);
    expect(chain.filter(f => f.status === 'active')).toHaveLength(1);
    expect(chain.filter(f => f.status === 'disputed')).toHaveLength(0);
    expect(chain.find(f => f.status === 'active')!.fields.a1c).toBe('6.8%');
  });
});

describe('disputed safety facts stay visible on SAFETY.md (marked)', () => {
  let tmp: string;
  let store: LedgerStore;
  let view: SafetyView;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-dsr-');
    store = new LedgerStore(tmp, mutableClock(DAY));
    view = new SafetyView(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('renders ONE marked bullet per disputed fact; unmarked after resolution', async () => {
    await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: prov('user') });
    // …while a same-rank conflict on a safety-relevant non-med disputes.
    await store.recordFact({ entity: 'knee-pain', type: 'symptom', fields: { severity: 'mild' }, provenance: prov('user'), safetyRelevant: true });
    const dispute = await store.recordFact({ entity: 'knee-pain', type: 'symptom', fields: { severity: 'severe' }, provenance: prov('user'), safetyRelevant: true });
    expect(dispute.kind).toBe('disputed');

    await view.render(await store.listSafetyRelevant());
    const rawMidDispute = (await view.read())!;
    expect(rawMidDispute).toMatch(/^- warfarin/gm);
    const kneeBullets = rawMidDispute.match(/^- knee-pain.*$/gm) ?? [];
    expect(kneeBullets).toHaveLength(1);
    expect(kneeBullets[0]).toMatch(/disput/i);

    if (dispute.kind === 'disputed') {
      await store.confirm(dispute.disputeToken.uuid, { winningVersion: dispute.versions[0].version });
    }
    await view.render(await store.listSafetyRelevant());
    const rawAfter = (await view.read())!;
    const kneeAfter = rawAfter.match(/^- knee-pain.*$/gm) ?? [];
    expect(kneeAfter).toHaveLength(1);
    expect(kneeAfter[0]).not.toMatch(/disput/i);
  });

  it('listSafetyRelevant includes disputed safety facts (render source)', async () => {
    await store.recordFact({ entity: 'rash', type: 'symptom', fields: { area: 'arm' }, provenance: prov('user'), safetyRelevant: true });
    await store.recordFact({ entity: 'rash', type: 'symptom', fields: { area: 'leg' }, provenance: prov('user'), safetyRelevant: true });
    const listed = await store.listSafetyRelevant();
    expect(listed.filter(f => f.entity === 'rash').length).toBeGreaterThanOrEqual(2); // original + heads
  });
});

describe('dedupe keys by type:entity', () => {
  let tmp: string;
  let store: LedgerStore;
  let view: SafetyView;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-dup-');
    store = new LedgerStore(tmp, mutableClock(DAY));
    view = new SafetyView(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('the SAME entity name as medication AND allergy renders BOTH bullets', async () => {
    await store.recordFact({ entity: 'penicillin', type: 'medication', fields: { dose: '500mg' }, provenance: prov('doctor') });
    await store.recordFact({ entity: 'penicillin', type: 'allergy', fields: { reaction: 'anaphylaxis' }, provenance: prov('doctor') });
    await view.render(await store.listSafetyRelevant());
    const raw = (await view.read())!;
    expect(raw).toMatch(/^- penicillin — 500mg$/m);          // Medications section
    expect(raw).toMatch(/^- penicillin$/m);                  // Allergies section
    expect(raw.match(/^- penicillin/gm)!.length).toBe(2);
  });
});

describe('ledger field KEYS cannot forge structure onto the ledger/SAFETY', () => {
  let tmp: string;
  let store: LedgerStore;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-safety-keys-');
    store = new LedgerStore(tmp, mutableClock(DAY));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const HOSTILE_KEY = [
    'x',
    '## evilmed',
    '### v1 (active)',
    '- provenance: doctor (1.00) · ',
    '- safety_relevant: true',
    '- dose',
  ].join('\n');

  it('a hostile field key does not fabricate a second entity on write→re-read round-trip', async () => {
    await store.recordFact({ entity: 'testmed', type: 'medication', fields: { [HOSTILE_KEY]: '999g' }, provenance: prov('user') });
    expect(await store.getActive('evilmed', 'medication')).toBeNull();       // no forged entity
    expect(await store.getActive('testmed', 'medication')).not.toBeNull();   // genuine fact intact
    const safety = await store.listSafetyRelevant();
    expect(safety.some(f => f.entity === 'evilmed')).toBe(false);            // nothing forged into SAFETY set
  });
});
