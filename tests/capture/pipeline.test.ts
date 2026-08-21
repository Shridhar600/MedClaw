import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  CapturePipeline,
  makeSafetyRenderer as makeSharedSafetyRenderer,
  type QueuePort,
  type LedgerWriter,
  type NarrativeWriter,
  type SafetyRenderer,
  type CuriosityWriter,
} from '../../src/capture';
import {
  LedgerStore,
  NarrativeStore,
  SafetyView,
  CuriosityQueue,
  type Provenance,
  type CaptureEvent,
} from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';

const CLOCK_DAY = '2026-08-20T10:00:00.000Z'; // the store clock's "today"
const CAPTURED = '2026-08-12T09:00:00.000Z'; // the event's captured day (divergent)
const CAPTURED_DAY = '2026-08-12';

function prov(capturedAt: string, source: Provenance['source'] = 'user'): Provenance {
  return { source, confidence: 0.9, anchor: '', capturedAt };
}

// W-C/D MED-15: the SAME adapter expression Gateway ships — no hand-rolled divergence.
const makeSafetyRenderer = makeSharedSafetyRenderer;

describe('CapturePipeline (Task 10 — both-lane, cross-anchored, port-injected)', () => {
  let tmp: string;
  let ledger: LedgerStore;
  let narrative: NarrativeStore;
  let view: SafetyView;
  let curiosity: CuriosityQueue;
  let safety: SafetyRenderer;
  let queueCalls: Array<{ priority: string; label: string }>;
  let queue: QueuePort;
  let pipeline: CapturePipeline;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-capture-'));
    const clock = mutableClock(CLOCK_DAY);
    ledger = new LedgerStore(tmp, clock);
    narrative = new NarrativeStore(tmp, clock);
    view = new SafetyView(tmp, clock);
    curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    safety = makeSafetyRenderer({ render: (facts) => view.render(facts), listSafetyRelevant: () => ledger.listSafetyRelevant() });

    queueCalls = [];
    queue = {
      enqueue: async (priority, op) => {
        queueCalls.push({ priority, label: op.label });
        return op.run();
      },
    };
    pipeline = new CapturePipeline({ queue, ledger, narrative, safety, curiosity });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('the concrete stores structurally satisfy the in-module ports (Task 13 wiring)', () => {
    const _l: LedgerWriter = ledger;
    const _n: NarrativeWriter = narrative;
    const _c: CuriosityWriter = curiosity;
    const _q: QueuePort = new WriteQueue({ journalPath: path.join(tmp, 'wq.journal') });
    void _l; void _n; void _c; void _q;
    // The structural satisfaction above IS the assertion — a mismatch fails at
    // compile time. (The old `expect(true).toBe(true)` asserted nothing.)
  });

  // W-C/D MED-15: a RESOLVED safety fact must still render on SAFETY.md — the
  // shared adapter sources from LedgerStore.listSafetyRelevant() (active +
  // resolved + disputed), NOT listByType (active-only). RED under the old
  // hand-rolled test adapter, which silently dropped resolved facts.
  it('renders a resolved safety fact on SAFETY.md via the safety-relevant source', async () => {
    await pipeline.ingest({
      profileId: 'default',
      source: 'chat',
      kind: 'ledger-fact',
      payload: {
        entity: 'metformin',
        type: 'medication',
        fields: { dose: '500mg' },
        provenance: prov(CAPTURED),
      },
    });
    // Resolve the fact in place (P1 has no transition API yet — direct store file).
    const fp = path.join(tmp, 'ledger', 'medications.md');
    fs.writeFileSync(fp, fs.readFileSync(fp, 'utf-8').replace('(active)', '(resolved)'));

    const rendered = await safety.render(await safety.listSafetyRelevant());
    expect(rendered).toMatch(/^- metformin/gm);
  });

  it('ledger-fact writes BOTH lanes with cross-anchors and re-renders SAFETY when safety-relevant (KNEE-01 / D8)', async () => {
    const event: CaptureEvent = {
      profileId: 'default',
      source: 'chat',
      kind: 'ledger-fact',
      payload: {
        entity: 'metformin',
        type: 'medication',
        fields: { dose: '500mg' },
        provenance: prov(CAPTURED),
        text: 'started metformin 500mg',
      },
    };
    const result = await pipeline.ingest(event);

    // Ledger lane
    const active = await ledger.getActive('metformin', 'medication');
    expect(active).not.toBeNull();
    expect(result).toMatchObject({ kind: 'applied' });

    // Narrative lane — cross-anchor back-ref under "## Ledger writes"
    const day = await narrative.read(CAPTURED_DAY);
    expect(day).toContain('## Ledger writes');
    expect(day).toContain(`- metformin → ${active!.id}`);

    // provenance.anchor points at the captured day's narrative line
    expect(active!.provenance.anchor).toMatch(new RegExp(`^memory/${CAPTURED_DAY}\\.md#L\\d+$`));

    // SAFETY.md re-rendered — a medication is always safety-relevant
    const safetyMd = await view.read();
    expect(safetyMd).toContain('metformin');

    // A single turn-priority queue op
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0].priority).toBe('turn');
  });

  it('derives the day from the event capturedAt, not the store clock (F20)', async () => {
    await pipeline.ingest({
      profileId: 'default', source: 'chat', kind: 'ledger-fact',
      payload: { entity: 'lisinopril', type: 'medication', fields: {}, provenance: prov(CAPTURED) },
    });
    expect(await narrative.read(CAPTURED_DAY)).not.toBeNull();
    expect(await narrative.read('2026-08-20')).toBeNull(); // NOT the store-clock day
    const active = await ledger.getActive('lisinopril', 'medication');
    expect(active!.provenance.anchor).toContain(`memory/${CAPTURED_DAY}.md`);
  });

  it('narrative-note writes ONLY the narrative lane (CHAT-06)', async () => {
    await pipeline.ingest({
      profileId: 'default', source: 'chat', kind: 'narrative-note',
      payload: { text: 'felt tired all afternoon', date: CAPTURED_DAY },
    });
    const day = await narrative.read(CAPTURED_DAY);
    expect(day).toContain('felt tired all afternoon');
    expect(day).not.toContain('## Ledger writes'); // no structured fact => no cross-anchor
    expect(await ledger.listByType('symptom')).toHaveLength(0);
  });

  it('metric-point writes a metric fact WITH a date field plus a narrative note (F19 / DIAB-02)', async () => {
    await pipeline.ingest({
      profileId: 'default', source: 'sensor', kind: 'metric-point',
      payload: {
        entity: 'fasting-glucose',
        fields: { value: 110, unit: 'mg/dL' },
        date: CAPTURED_DAY,
        provenance: prov(CAPTURED, 'sensor'),
        note: 'fasting glucose 110 mg/dL',
      },
    });
    const active = await ledger.getActive('fasting-glucose', 'metric');
    expect(active).not.toBeNull();
    expect(active!.fields.date).toBe(CAPTURED_DAY);

    const day = await narrative.read(CAPTURED_DAY);
    expect(day).toContain('fasting glucose 110 mg/dL');
    expect(day).toContain(`- fasting-glucose → ${active!.id}`);
  });

  it('ledger-correction retracts the wrong entity and records the corrected one with a cross-link, both lanes, one op (DAD-10)', async () => {
    // Seed the mistaken fact (a non-safety symptom so the retract applies without confirmation).
    const wrong = await ledger.recordFact({
      entity: 'headche', type: 'symptom', fields: {}, provenance: prov(CAPTURED),
    });
    expect(wrong.kind).toBe('applied');
    const wrongId = wrong.kind === 'applied' ? wrong.fact.id : '';

    queueCalls.length = 0; // count only the correction op
    const result = await pipeline.ingest({
      profileId: 'default', source: 'chat', kind: 'ledger-correction',
      payload: {
        wrong: { entity: 'headche', type: 'symptom' },
        corrected: {
          entity: 'headache', type: 'symptom', fields: {},
          provenance: prov(CAPTURED), corrects: wrongId,
        },
        note: 'corrected typo: headche -> headache',
      },
    });

    expect(await ledger.getActive('headche', 'symptom')).toBeNull(); // retracted
    const corrected = await ledger.getActive('headache', 'symptom');
    expect(corrected).not.toBeNull();
    expect(corrected!.corrects).toBe(wrongId);
    expect(result).toMatchObject({ kind: 'applied' });

    const day = await narrative.read(CAPTURED_DAY);
    expect(day).toContain('corrected typo');
    expect(day).toContain(`- headache → ${corrected!.id}`);

    expect(queueCalls).toHaveLength(1); // single queue op for the whole correction
  });

  it('curiosity-item routes to the curiosity queue', async () => {
    await pipeline.ingest({
      profileId: 'default', source: 'agent', kind: 'curiosity-item',
      payload: { kind: 'follow-up', description: 'ask about sleep next week' },
    });
    const items = await curiosity.list();
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('ask about sleep next week');
  });

  it('on needs-confirmation the narrative note stands but no cross-anchor is written and SAFETY is not re-rendered', async () => {
    // Seed an active med, then capture a conflicting dose from the same authority => needs-confirmation.
    await ledger.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: prov(CAPTURED) });
    const before = await view.read();

    const result = await pipeline.ingest({
      profileId: 'default', source: 'chat', kind: 'ledger-fact',
      payload: { entity: 'warfarin', type: 'medication', fields: { dose: '10mg' }, provenance: prov(CAPTURED), text: 'now on warfarin 10mg' },
    });

    expect(result).toMatchObject({ kind: 'needs-confirmation' });
    const day = await narrative.read(CAPTURED_DAY);
    expect(day).toContain('now on warfarin 10mg'); // narrative note stands
    expect(day).not.toContain('## Ledger writes'); // no applied fact => no anchor
    expect(await view.read()).toBe(before); // SAFETY.md unchanged (no applied change)
    // Still the old active version
    const active = await ledger.getActive('warfarin', 'medication');
    expect(active!.fields.dose).toBe('5mg');
  });

  it('unknown kind warns and continues without throwing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bogus = { profileId: 'default', source: 'x', kind: 'bogus', payload: {} } as unknown as CaptureEvent;
    await expect(pipeline.ingest(bogus)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
