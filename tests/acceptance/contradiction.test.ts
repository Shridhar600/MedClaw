import * as fs from 'fs';
import * as path from 'path';

import { LedgerStore, NarrativeStore, SafetyView, CuriosityQueue, renderLedgerFile } from '../../src/memcore';
import type { Provenance } from '../../src/memcore';
import { CapturePipeline, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { createLedgerTools } from '../../src/tools/ledger-tools';
import { mutableClock, seqIdGen, fact } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';
import { makeTestTemp } from '../helpers/test-temp';

function prov(source: Provenance['source'], capturedAt: string): Provenance {
  return { source, confidence: 0.9, anchor: '', capturedAt };
}

describe('Contradiction acceptance', () => {
  let tmp: string;
  let ledger: LedgerStore;
  let view: SafetyView;
  let tools: Tool[];
  let clock: ReturnType<typeof mutableClock>;
  const byName = (n: string): Tool => tools.find(t => t.name === n)!;
  const renderSafety = async (): Promise<string> => view.render(await ledger.listSafetyRelevant());
  const tokenOf = (text: string): string => (text.match(/tokenId="([0-9a-f-]+)"/) ?? [])[1]!;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-contra-');
    clock = mutableClock('2026-07-01T09:00:00.000Z');
    ledger = new LedgerStore(tmp, clock);
    const narrative = new NarrativeStore(tmp, clock);
    view = new SafetyView(tmp, clock);
    const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    const safety = makeSafetyRenderer({ render: (facts) => view.render(facts), listSafetyRelevant: () => ledger.listSafetyRelevant() });
    const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
    const pipeline = new CapturePipeline({ queue, ledger, narrative, safety, curiosity });
    tools = createLedgerTools({ pipeline, ledger, safety, queue, clock });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('create → retract → re-state (doctor 850) → discontinue: all 4 versions preserved, SAFETY tracks each transition', async () => {
    clock.set('2026-07-01T09:00:00.000Z');
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, source: 'user' });
    const v1 = await ledger.getActive('metformin', 'medication');
    expect(v1).not.toBeNull();
    expect(v1!.fields.dose).toBe('500mg');
    expect(v1!.provenance.source).toBe('user');
    expect(await renderSafety()).toContain('metformin');

    clock.set('2026-07-15T09:00:00.000Z');
    const rr = await ledger.retract({ entity: 'metformin', type: 'medication', provenance: prov('user', '2026-07-15T09:00:00.000Z') });
    expect(rr.kind).toBe('needs-confirmation');
    if (rr.kind === 'needs-confirmation' && rr.token) await ledger.confirm(rr.token.uuid);
    expect(await ledger.getActive('metformin', 'medication')).toBeNull();
    expect(await renderSafety()).not.toContain('metformin');

    clock.set('2026-07-22T09:00:00.000Z');
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, source: 'doctor' });
    const v3 = await ledger.getActive('metformin', 'medication');
    expect(v3!.fields.dose).toBe('850mg');
    expect(v3!.provenance.source).toBe('doctor');
    expect(await renderSafety()).toContain('metformin');

    clock.set('2026-08-05T09:00:00.000Z');
    const remove = await byName('ledger_remove').execute({ entity: 'metformin', type: 'medication', reason: 'doctor took me off it' });
    expect(remove.content[0].text).toMatch(/confirm/i);
    const applied = await byName('ledger_update').execute({ tokenId: tokenOf(remove.content[0].text), confirm: true });
    expect(applied.isError).toBeFalsy();
    expect(await ledger.getActive('metformin', 'medication')).toBeNull();
    expect(await renderSafety()).not.toContain('metformin');

    const chain = await ledger.getChain('metformin', 'medication');
    expect(chain).toHaveLength(4);
    expect(chain.map(f => f.status).sort()).toEqual(['discontinued', 'retracted', 'superseded', 'superseded']);
    const discontinued = chain.find(f => f.status === 'discontinued')!;
    expect(discontinued.discontinuedReason).toMatch(/took me off/);
  });

  it('a dual-active entity is DETECTED and surfaced to the agent as a conflict', async () => {
    const day = '2026-07-01T09:00:00.000Z';
    const v1 = fact('metformin', 'medication', { version: 1, status: 'active', fields: { dose: '500mg' }, safetyRelevant: true, createdAt: day });
    const v2 = fact('metformin', 'medication', { version: 2, status: 'retracted', supersedes: 'metformin@v1', fields: { dose: '500mg' }, safetyRelevant: true, createdAt: day });
    const v3 = fact('metformin', 'medication', { version: 3, status: 'active', fields: { dose: '500mg' }, safetyRelevant: true, createdAt: day });
    fs.mkdirSync(path.join(tmp, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ledger', 'medications.md'), renderLedgerFile([v1, v2, v3]));

    expect(await ledger.listActiveConflicts('medication')).toContain('metformin');

    const q = await byName('ledger_query').execute({ type: 'medication' });
    expect(q.content[0].text).toMatch(/conflict/i);
    expect(q.content[0].text).toMatch(/metformin/);
  });

  it('doctor-sourced active is never auto-superseded by a lower-authority user statement (NEEDS_CONFIRM)', async () => {
    clock.set('2026-07-01T09:00:00.000Z');
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, source: 'doctor' });

    const conflict = await ledger.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: prov('user', '2026-07-02T09:00:00.000Z') });
    expect(conflict.kind).toBe('needs-confirmation');
    expect((await ledger.getActive('metformin', 'medication'))!.fields.dose).toBe('850mg');
    expect((await ledger.getActive('metformin', 'medication'))!.provenance.source).toBe('doctor');
  });
});
