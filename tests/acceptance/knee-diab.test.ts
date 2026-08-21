// P1 acceptance — Suite A (Knee) + Suite B (Diabetes) ledger halves (specs/09).
// KNEE-01/03/04/08 + DIAB-01/02/04/06. Drives the real ledger tools/store + SAFETY view.
//
// spec↔model MAPPING (G5, plan Task 14.3) + scope notes:
//   - spec `source: self-reported` → model provenance `user`; `doctor-prescription`/`Dr. X` → `doctor`.
//   - spec appointment `status: pending|completed` → model = an ACTIVE fact with a `state` field
//     (pending/completed); FactStatus has no `pending`.
//   - spec condition `status: managed` → model `active` (safety_relevant flag drives SAFETY inclusion).
//   - spec `ended:` → the discontinued version's captured timestamp.
//   - `replaces` has NO agent tool param in P1 (SB-13) → the naproxen←ibuprofen link is written at the
//     memcore layer (store.recordFact); `pause()` likewise has no tool (G10) — exercised on the store.
// DEFERRED per plan coverage table: KNEE-01/03 commitments + HEARTBEAT → P4; KNEE-04 MRI sub-agent → P2/P4;
//   KNEE-08 recall half → P2; DIAB-01 MEMORY.md-summary half → budget-gated/best-effort (not asserted here).
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { LedgerStore, NarrativeStore, SafetyView, CuriosityQueue } from '../../src/memcore';
import type { Provenance } from '../../src/memcore';
import { CapturePipeline, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { createLedgerTools } from '../../src/tools/ledger-tools';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';

const KNOWN_SIDE_EFFECTS: Record<string, string[]> = {
  metformin: ['nausea', 'b12-deficiency'],
  jardiance: ['genital-yeast-infection', 'uti'],
};

function prov(source: Provenance['source'], capturedAt: string): Provenance {
  return { source, confidence: 0.9, anchor: '', capturedAt };
}

describe('KNEE + DIAB acceptance (specs/09 Suites A/B — ledger half)', () => {
  let tmp: string;
  let ledger: LedgerStore;
  let narrative: NarrativeStore;
  let view: SafetyView;
  let tools: Tool[];
  let clock: ReturnType<typeof mutableClock>;
  const byName = (n: string): Tool => tools.find(t => t.name === n)!;
  const renderSafety = async (): Promise<string> => view.render(await ledger.listSafetyRelevant());
  const tokenOf = (text: string): string => (text.match(/tokenId="([0-9a-f-]+)"/) ?? [])[1]!;
  const read = (rel: string): string => fs.readFileSync(path.join(tmp, rel), 'utf8');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-kneediab-'));
    clock = mutableClock('2026-07-07T09:00:00.000Z');
    ledger = new LedgerStore(tmp, clock);
    narrative = new NarrativeStore(tmp, clock);
    view = new SafetyView(tmp, clock);
    const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    const safety = makeSafetyRenderer({ render: (facts) => view.render(facts), listSafetyRelevant: () => ledger.listSafetyRelevant() });
    const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
    const pipeline = new CapturePipeline({ queue, ledger, narrative, safety, curiosity });
    tools = createLedgerTools({
      pipeline, ledger, safety, queue, clock, narrative,
      sideEffectLookup: async (entity) => KNOWN_SIDE_EFFECTS[entity] ?? [],
    });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('KNEE-01 — initial injury writes both lanes with cross-anchors; SAFETY excludes the transient injury', async () => {
    await byName('ledger_record').execute({ entity: 'knee-injury', type: 'condition', fields: { status: 'active' }, source: 'user', note: 'injured my knee on the trek, limping' });
    await byName('ledger_record').execute({ entity: 'limping', type: 'symptom', fields: { related_to: 'knee-injury' }, source: 'user', note: 'limping' });
    await byName('ledger_record').execute({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg PRN' }, source: 'user', note: 'taking ibuprofen 400mg as needed' });

    // Ledger lanes
    expect((await ledger.getActive('knee-injury', 'condition'))!.provenance.source).toBe('user');
    expect((await ledger.getActive('limping', 'symptom'))!.fields.related_to).toBe('knee-injury');
    expect((await ledger.getActive('ibuprofen', 'medication'))!.fields.dose).toBe('400mg PRN');

    // Narrative lane: both the raw notes and the `## Ledger writes` cross-anchors for each entity.
    const day = read(path.join('memory', '2026-07-07.md'));
    expect(day).toContain('## Ledger writes');
    for (const e of ['knee-injury', 'limping', 'ibuprofen']) expect(day).toContain(`${e} →`);

    // SAFETY.md must NOT carry the transient self-reported injury (not safety-relevant).
    expect(await renderSafety()).not.toContain('knee-injury');
  });

  it('KNEE-03 — doctor-visit appointment recorded (pending, dated)', async () => {
    await byName('ledger_record').execute({ entity: 'knee-doctor-visit', type: 'appointment', fields: { state: 'pending', date: '2026-07-15' }, source: 'user', note: 'seeing the doctor Wed the 15th' });
    const appt = await ledger.getActive('knee-doctor-visit', 'appointment');
    expect(appt!.fields.state).toBe('pending');
    expect(appt!.fields.date).toBe('2026-07-15');
  });

  it('KNEE-04 — follow-up: diagnosis update, ibuprofen discontinued (ended), naproxen active + replaces, appointment completed, MRI referral', async () => {
    // Seed KNEE-03 post state.
    await byName('ledger_record').execute({ entity: 'knee-injury', type: 'condition', fields: { status: 'active' }, source: 'user' });
    await byName('ledger_record').execute({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg PRN' }, source: 'user' });
    await byName('ledger_record').execute({ entity: 'knee-doctor-visit', type: 'appointment', fields: { state: 'pending', date: '2026-07-15' }, source: 'user' });

    clock.set('2026-07-16T09:00:00.000Z');
    // Diagnosis update (new field, no conflict → applies).
    await byName('ledger_record').execute({ entity: 'knee-injury', type: 'condition', fields: { diagnosis: 'mild MCL sprain' }, source: 'doctor' });
    expect((await ledger.getActive('knee-injury', 'condition'))!.fields.diagnosis).toBe('mild MCL sprain');

    // ibuprofen discontinued (med → confirm round-trip); ended = the discontinued version's timestamp.
    const rm = await byName('ledger_remove').execute({ entity: 'ibuprofen', type: 'medication', reason: 'switched to naproxen' });
    await byName('ledger_update').execute({ tokenId: tokenOf(rm.content[0].text), confirm: true });
    const ibu = (await ledger.getChain('ibuprofen', 'medication')).find(f => f.status === 'discontinued')!;
    expect(ibu).toBeDefined();
    expect(ibu.provenance.capturedAt.slice(0, 10)).toBe('2026-07-16'); // ended date

    // naproxen created active + replaces ibuprofen (memcore layer — no tool param for `replaces`).
    // The forward substitution link (naproxen → replaces → ibuprofen) is caller-supplied and
    // round-trips; the reverse `replacedBy` is written per-side by the caller (recordFact does not
    // auto-stamp the other entity), so P1 asserts the forward link the substitution establishes.
    await ledger.recordFact({ entity: 'naproxen', type: 'medication', fields: { dose: '500mg BID', known_side_effects: [] }, provenance: prov('doctor', '2026-07-16T09:00:00.000Z'), replaces: 'ibuprofen' });
    expect((await ledger.getActive('naproxen', 'medication'))!.fields.dose).toBe('500mg BID');
    expect((await ledger.getCrossLinks('naproxen', 'medication')).replaces).toContain('ibuprofen');

    // appointment completed (doctor rank auto-applies for non-safety type); MRI referral created.
    await byName('ledger_record').execute({ entity: 'knee-doctor-visit', type: 'appointment', fields: { state: 'completed' }, source: 'doctor' });
    expect((await ledger.getActive('knee-doctor-visit', 'appointment'))!.fields.state).toBe('completed');
    await byName('ledger_record').execute({ entity: 'mri-referral', type: 'appointment', fields: { state: 'pending' }, source: 'doctor' });
    expect((await ledger.getActive('mri-referral', 'appointment'))!.fields.state).toBe('pending');
  });

  it('KNEE-08 — pause preserves the gym-plan detail in pre_pause_summary across the gap', async () => {
    await byName('ledger_record').execute({ entity: 'gym-goal', type: 'goal', fields: { target: '3x/week strength' }, source: 'user' });
    const summary = '2x/week moderate strength, upper/lower split, bodyweight + light dumbbells, 30-40min sessions';
    const paused = await ledger.pause('gym-goal', 'goal', prov('user', '2026-10-25T09:00:00.000Z'), { prePauseSummary: summary });
    expect(paused.kind).toBe('applied');
    expect(await ledger.getActive('gym-goal', 'goal')).toBeNull(); // paused is not active
    const pausedFact = (await ledger.getChain('gym-goal', 'goal')).find(f => f.status === 'paused')!;
    expect(pausedFact.fields.pre_pause_summary).toBe(summary);
  });

  it('DIAB-01 — diabetes + metformin seed safety-relevant entries; SAFETY seeded via D8; known_side_effects auto-populated', async () => {
    await byName('ledger_record').execute({ entity: 'type-2-diabetes', type: 'condition', fields: { started: '2025' }, safety_relevant: true, source: 'user', note: 'I have type-2 diabetes diagnosed last year' });
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '500mg BID', started: '2025' }, source: 'user', note: 'metformin 500mg twice a day' });

    const diabetes = await ledger.getActive('type-2-diabetes', 'condition');
    expect(diabetes!.safetyRelevant).toBe(true);
    const met = await ledger.getActive('metformin', 'medication');
    expect(met!.fields.dose).toBe('500mg BID');
    expect(met!.fields.known_side_effects).toEqual(['nausea', 'b12-deficiency']);

    const safety = await renderSafety();
    expect(safety).toContain('diabetes');
    expect(safety).toContain('metformin');
    expect(read(path.join('memory', '2026-07-07.md'))).toContain('type-2 diabetes');
  });

  it('DIAB-02 — glucose reading captured as a typed metric with a string date field', async () => {
    await byName('ledger_record').execute({ entity: 'glucose', type: 'metric', fields: { value: 132, unit: 'mg/dL', context: 'fasting', date: '2026-07-07' }, source: 'user', note: 'Glucose reading 132 fasting' });
    const g = await ledger.getActive('glucose', 'metric');
    expect(g!.fields.value).toBe(132);
    expect(g!.fields.unit).toBe('mg/dL');
    expect(g!.fields.context).toBe('fasting');
    expect(g!.fields.date).toBe('2026-07-07'); // string date survives detectValue (not coerced)
    expect(read(path.join('memory', '2026-07-07.md'))).toContain('Glucose reading 132 fasting');
  });

  it('DIAB-04 — dose change creates a version chain (med conflict → confirm); new med added; SAFETY updated', async () => {
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '500mg BID' }, source: 'user' });
    // Doctor increases the dose — a med conflict ALWAYS needs confirmation (AR fix), even from a doctor.
    const change = await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '1000mg BID' }, source: 'doctor' });
    expect(change.content[0].text).toMatch(/confirm/i);
    await byName('ledger_update').execute({ tokenId: tokenOf(change.content[0].text), confirm: true });

    const chain = await ledger.getChain('metformin', 'medication');
    const active = chain.find(f => f.status === 'active')!;
    expect(active.fields.dose).toBe('1000mg BID');
    expect(active.supersedes).toBeDefined();
    expect(chain.filter(f => f.status === 'superseded')).toHaveLength(1);

    // New med jardiance added active; SAFETY carries it.
    await byName('ledger_record').execute({ entity: 'jardiance', type: 'medication', fields: { dose: '10mg daily' }, source: 'doctor' });
    expect((await ledger.getActive('jardiance', 'medication'))!.fields.dose).toBe('10mg daily');
    expect(await renderSafety()).toContain('jardiance');
  });

  it('DIAB-06 — known_side_effects auto-populated at creation; [] fallback when no lookup, never absent', async () => {
    await byName('ledger_record').execute({ entity: 'jardiance', type: 'medication', fields: { dose: '10mg daily' }, source: 'doctor' });
    expect((await ledger.getActive('jardiance', 'medication'))!.fields.known_side_effects).toEqual(['genital-yeast-infection', 'uti']);

    // No-lookup tools instance → [] fallback (present, not absent).
    const bare = createLedgerTools({ pipeline: new CapturePipeline({ queue: { enqueue: async (_p, op) => op.run() }, ledger, narrative, safety: makeSafetyRenderer({ render: (f) => view.render(f), listSafetyRelevant: () => ledger.listSafetyRelevant() }), curiosity: new CuriosityQueue(tmp, clock, seqIdGen('c2'), 'default') }), ledger, safety: makeSafetyRenderer({ render: (f) => view.render(f), listSafetyRelevant: () => ledger.listSafetyRelevant() }), queue: { enqueue: async (_p, op) => op.run() }, clock });
    await bare.find(t => t.name === 'ledger_record')!.execute({ entity: 'lisinopril', type: 'medication', fields: { dose: '5mg' }, source: 'doctor' });
    const lis = await ledger.getActive('lisinopril', 'medication');
    expect(lis!.fields.known_side_effects).toEqual([]);
  });
});
