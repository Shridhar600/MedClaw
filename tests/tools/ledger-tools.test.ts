import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { createLedgerTools } from '../../src/tools/ledger-tools';
import { LedgerStore, NarrativeStore, SafetyView, CuriosityQueue } from '../../src/memcore';
import { CapturePipeline, makeSafetyRenderer as makeSharedSafetyRenderer, type QueuePort } from '../../src/capture';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';

const DAY = '2026-08-20T10:00:00.000Z';

// W-C/D MED-15: the SAME adapter expression Gateway ships.
const makeSafetyRenderer = makeSharedSafetyRenderer;

describe('ledger tools (Task 12.1–12.3)', () => {
  let tmp: string;
  let ledger: LedgerStore;
  let view: SafetyView;
  let tools: Tool[];
  const byName = (n: string): Tool => tools.find(t => t.name === n)!;

  const build = (opts: { sideEffectLookup?: (e: string, f: Record<string, unknown>) => Promise<string[]> } = {}): void => {
    const clock = mutableClock(DAY);
    ledger = new LedgerStore(tmp, clock);
    const narrative = new NarrativeStore(tmp, clock);
    view = new SafetyView(tmp, clock);
    const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    const safety = makeSafetyRenderer({ render: (facts) => view.render(facts), listSafetyRelevant: () => ledger.listSafetyRelevant() });
    const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
    const pipeline = new CapturePipeline({ queue, ledger, narrative, safety, curiosity });
    tools = createLedgerTools({ pipeline, ledger, safety, queue, clock, sideEffectLookup: opts.sideEffectLookup });
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-ledgertool-'));
    build();
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('ledger_record applies a new fact and writes both lanes + SAFETY.md', async () => {
    const r = await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, note: 'started metformin 500mg' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/metformin/);
    expect(await ledger.getActive('metformin', 'medication')).not.toBeNull();
    expect(await view.read()).toContain('metformin');
  });

  it('ledger_record surfaces a needs-confirmation token on a conflicting med', async () => {
    await ledger.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY } });
    const r = await byName('ledger_record').execute({ entity: 'warfarin', type: 'medication', fields: { dose: '10mg' } });
    expect(r.content[0].text).toMatch(/confirm/i);
    expect(r.content[0].text).toMatch(/ledger_update/);
    expect(r.content[0].text).toMatch(/[0-9a-f]{12}/); // token id surfaced
  });

  it('DIAB-06: auto-populates known_side_effects for a medication via sideEffectLookup', async () => {
    build({ sideEffectLookup: async () => ['nausea', 'dizziness'] });
    await byName('ledger_record').execute({ entity: 'lisinopril', type: 'medication', fields: {} });
    const f = await ledger.getActive('lisinopril', 'medication');
    expect(f!.fields.known_side_effects).toEqual(['nausea', 'dizziness']);
  });

  it('DIAB-06: falls back to [] when sideEffectLookup throws (never absent)', async () => {
    build({ sideEffectLookup: async () => { throw new Error('llm down'); } });
    await byName('ledger_record').execute({ entity: 'atorvastatin', type: 'medication', fields: {} });
    const f = await ledger.getActive('atorvastatin', 'medication');
    expect(f!.fields.known_side_effects).toEqual([]);
  });

  it('ledger_update confirm applies the pending change and re-renders SAFETY.md', async () => {
    await ledger.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY } });
    const rec = await byName('ledger_record').execute({ entity: 'warfarin', type: 'medication', fields: { dose: '10mg' } });
    const tokenId = (rec.content[0].text.match(/[0-9a-f]{12}/) ?? [])[0]!;

    const upd = await byName('ledger_update').execute({ tokenId, confirm: true });
    expect(upd.isError).toBeFalsy();
    const active = await ledger.getActive('warfarin', 'medication');
    expect(active!.fields.dose).toBe('10mg');
    expect(await view.read()).toContain('warfarin');
  });

  it('ledger_update with confirm=false does not apply the change', async () => {
    await ledger.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY } });
    const rec = await byName('ledger_record').execute({ entity: 'warfarin', type: 'medication', fields: { dose: '10mg' } });
    const tokenId = (rec.content[0].text.match(/[0-9a-f]{12}/) ?? [])[0]!;
    const upd = await byName('ledger_update').execute({ tokenId, confirm: false });
    expect(upd.content[0].text).toMatch(/declin|not applied/i);
    expect((await ledger.getActive('warfarin', 'medication'))!.fields.dose).toBe('5mg');
  });

  it('ledger_query status=active returns active facts', async () => {
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' } });
    const r = await byName('ledger_query').execute({ type: 'medication', status: 'active' });
    expect(r.content[0].text).toMatch(/metformin/);
  });

  it('ledger_query status=all returns the full chain for an entity', async () => {
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, note: 'v1' });
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { notes: 'took with food' } });
    const r = await byName('ledger_query').execute({ entity: 'metformin', type: 'medication', status: 'all' });
    // W-C/D MED-15 (T3): assert the CHAIN SHAPE, not a regex over rendered text.
    const chain = await ledger.getChain('metformin', 'medication');
    expect(chain).toHaveLength(2);
    expect(chain.map(f => f.version).sort()).toEqual([1, 2]);
    // And the rendered text reflects both versions.
    expect(r.content[0].text).toContain('v1');
    expect(r.content[0].text).toContain('v2');
  });
});
