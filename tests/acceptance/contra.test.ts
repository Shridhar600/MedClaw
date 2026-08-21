// P1 acceptance — Suite C: Contradictor (specs/09 CONTRA-01/02/05).
//
// Drives the real ledger tools + store the way the agent would, and asserts the on-disk
// version chain + SAFETY.md. spec↔model MAPPING (G5, plan Task 14.3):
//   - spec `status: retraction`      → model status `retracted`
//   - spec `reason: doctor-discontinued` → model top-level `discontinuedReason`
//   - spec `source: user-statement`  → model provenance source `user`; `doctor-prescription` → `doctor`
// Tool surface note (G10): retract() has NO agent tool in P1 (like pause) — it is exercised at the
// memcore layer; discontinue is the agent-reachable removal (ledger_remove → ledger_update confirm).
// CONTRA-02 (A5): the store never auto-produces `disputed` for a med-class entity, so the P1 assertion
// is SEED-based + tool-surfaced — a dual-active seed is surfaced (both actives visible) to the agent.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { LedgerStore, NarrativeStore, SafetyView, CuriosityQueue, renderLedgerFile } from '../../src/memcore';
import type { Provenance } from '../../src/memcore';
import { CapturePipeline, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { createLedgerTools } from '../../src/tools/ledger-tools';
import { mutableClock, seqIdGen, fact } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';

function prov(source: Provenance['source'], capturedAt: string): Provenance {
  return { source, confidence: 0.9, anchor: '', capturedAt };
}

describe('CONTRA acceptance (specs/09 Suite C)', () => {
  let tmp: string;
  let ledger: LedgerStore;
  let view: SafetyView;
  let tools: Tool[];
  let clock: ReturnType<typeof mutableClock>;
  const byName = (n: string): Tool => tools.find(t => t.name === n)!;
  const renderSafety = async (): Promise<string> => view.render(await ledger.listSafetyRelevant());
  const tokenOf = (text: string): string => (text.match(/tokenId="([0-9a-f-]+)"/) ?? [])[1]!;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-contra-'));
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

  it('CONTRA-01 — create → retract → re-state (doctor 850) → discontinue: all 4 versions preserved, SAFETY tracks each transition', async () => {
    // Turn 1 (2026-07-01): user takes metformin 500mg.
    clock.set('2026-07-01T09:00:00.000Z');
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, source: 'user' });
    const v1 = await ledger.getActive('metformin', 'medication');
    expect(v1).not.toBeNull();
    expect(v1!.fields.dose).toBe('500mg');
    expect(v1!.provenance.source).toBe('user');
    expect(await renderSafety()).toContain('metformin');

    // Turn 2 (2026-07-15): "I never said that" → retraction (memcore-layer; med-class needs confirmation).
    clock.set('2026-07-15T09:00:00.000Z');
    const rr = await ledger.retract({ entity: 'metformin', type: 'medication', provenance: prov('user', '2026-07-15T09:00:00.000Z') });
    expect(rr.kind).toBe('needs-confirmation');
    if (rr.kind === 'needs-confirmation' && rr.token) await ledger.confirm(rr.token.uuid);
    expect(await ledger.getActive('metformin', 'medication')).toBeNull();
    expect(await renderSafety()).not.toContain('metformin');

    // Turn 3 (2026-07-22): doctor re-states at 850mg → fresh active (no active to conflict with).
    clock.set('2026-07-22T09:00:00.000Z');
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, source: 'doctor' });
    const v3 = await ledger.getActive('metformin', 'medication');
    expect(v3!.fields.dose).toBe('850mg');
    expect(v3!.provenance.source).toBe('doctor');
    expect(await renderSafety()).toContain('metformin');

    // Turn 4 (2026-08-05): discontinue via the agent-reachable tool + confirm round-trip.
    clock.set('2026-08-05T09:00:00.000Z');
    const remove = await byName('ledger_remove').execute({ entity: 'metformin', type: 'medication', reason: 'doctor took me off it' });
    expect(remove.content[0].text).toMatch(/confirm/i);
    const applied = await byName('ledger_update').execute({ tokenId: tokenOf(remove.content[0].text), confirm: true });
    expect(applied.isError).toBeFalsy();
    expect(await ledger.getActive('metformin', 'medication')).toBeNull();
    expect(await renderSafety()).not.toContain('metformin');

    // All four versions persist; none deleted; terminal reason mapped.
    const chain = await ledger.getChain('metformin', 'medication');
    expect(chain).toHaveLength(4);
    expect(chain.map(f => f.status).sort()).toEqual(['discontinued', 'retracted', 'superseded', 'superseded']);
    const discontinued = chain.find(f => f.status === 'discontinued')!;
    expect(discontinued.discontinuedReason).toMatch(/took me off/);
  });

  it('CONTRA-02 — a dual-active seed is surfaced to the agent (store never auto-disputes med-class; A5)', async () => {
    // Seed a chain where v1 and v3 are BOTH active for the same entity (spec-09 permits seeding).
    const day = '2026-07-01T09:00:00.000Z';
    const v1 = fact('metformin', 'medication', { version: 1, status: 'active', fields: { dose: '500mg' }, safetyRelevant: true, createdAt: day });
    const v2 = fact('metformin', 'medication', { version: 2, status: 'retracted', supersedes: 'metformin@v1', fields: { dose: '500mg' }, safetyRelevant: true, createdAt: day });
    const v3 = fact('metformin', 'medication', { version: 3, status: 'active', fields: { dose: '500mg' }, safetyRelevant: true, createdAt: day });
    fs.mkdirSync(path.join(tmp, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ledger', 'medications.md'), renderLedgerFile([v1, v2, v3]));

    // Tool-surfaced: listByType returns BOTH active versions so the agent can see the conflict.
    const actives = await ledger.listByType('medication');
    const metforminActives = actives.filter(f => f.entity === 'metformin');
    expect(metforminActives).toHaveLength(2);
    expect(metforminActives.map(f => f.version).sort()).toEqual([1, 3]);

    // ledger_query type=medication renders both actives (the conflict is visible in the tool output).
    const q = await byName('ledger_query').execute({ type: 'medication' });
    expect(q.content[0].text.match(/metformin/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('CONTRA-05 — doctor-sourced active is never auto-superseded by a lower-authority user statement (NEEDS_CONFIRM)', async () => {
    clock.set('2026-07-01T09:00:00.000Z');
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, source: 'doctor' });

    // User claims a different (lower dose) with lower authority → must NOT auto-apply.
    const conflict = await ledger.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: prov('user', '2026-07-02T09:00:00.000Z') });
    expect(conflict.kind).toBe('needs-confirmation');
    // No change without confirmation: the doctor's 850mg is still active.
    expect((await ledger.getActive('metformin', 'medication'))!.fields.dose).toBe('850mg');
    expect((await ledger.getActive('metformin', 'medication'))!.provenance.source).toBe('doctor');
  });
});
