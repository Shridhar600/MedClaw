// W-C/D hostile-panel fix pass — capture-pipeline regression suite.
// Each test was proven RED on p1-memory-core @ cbf6c40 before its fix landed.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { LedgerStore, NarrativeStore, SafetyView, CuriosityQueue } from '../../src/memcore';
import { CapturePipeline, type QueuePort } from '../../src/capture';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';

const DAY = '2026-08-20T10:00:00.000Z';
const SECRET = 'api_key: "abcd1234abcd1234abcd1234ab"';

describe('W-C/D fix pass — CRED: pipeline-level credential scan (defense-in-depth)', () => {
  let tmp: string;
  let narrative: NarrativeStore;
  let pipeline: CapturePipeline;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-cap-'));
    const clock = mutableClock(DAY);
    const ledger = new LedgerStore(tmp, clock);
    narrative = new NarrativeStore(tmp, clock);
    const view = new SafetyView(tmp, clock);
    const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    const safety = {
      render: (facts: Parameters<typeof view.render>[0]) => view.render(facts),
      listSafetyRelevant: () => ledger.listSafetyRelevant(),
    };
    const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
    pipeline = new CapturePipeline({ queue, ledger, narrative, safety, curiosity, clock });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('a narrative-note carrying a credential is skipped (never persisted), never throws', async () => {
    await expect(pipeline.ingest({
      profileId: 'default',
      source: 'chat',
      kind: 'narrative-note',
      payload: { text: `note to self ${SECRET}` },
    })).resolves.not.toThrow();
    expect(fs.existsSync(path.join(tmp, 'memory'))).toBe(false);
  });

  it('clean narrative notes still land (no false-positive regression)', async () => {
    await pipeline.ingest({
      profileId: 'default',
      source: 'chat',
      kind: 'narrative-note',
      payload: { text: 'token ring device reported 500mg dose' },
    });
    expect(fs.existsSync(path.join(tmp, 'memory'))).toBe(true);
  });
});

describe('W-C/D fix pass — PHI: correction warn never carries the entity name', () => {
  afterEach(() => jest.restoreAllMocks());

  function makePl(tmp: string) {
    const clock = mutableClock(DAY);
    const ledger = new LedgerStore(tmp, clock);
    const narrative = new NarrativeStore(tmp, clock);
    const view = new SafetyView(tmp, clock);
    const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    const safety = {
      render: (facts: Parameters<typeof view.render>[0]) => view.render(facts),
      listSafetyRelevant: () => ledger.listSafetyRelevant(),
    };
    const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
    return { pl: new CapturePipeline({ queue, ledger, narrative, safety, curiosity, clock }), ledger };
  }

  it('correction retract needs-confirmation warns WITHOUT the wrong entity', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-phicap-'));
    try {
      const { pl } = makePl(tmp);
      // Active med fact → a later correction's retract arm will need confirmation.
      await ledgerSeed(pl);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await pl.ingest({
        profileId: 'default',
        source: 'chat',
        kind: 'ledger-correction',
        payload: {
          wrong: { entity: 'metformin-PHI-MARKER-8686', type: 'medication' as const },
          corrected: {
            entity: 'glipizide', type: 'medication' as const, fields: { dose: '5mg' },
            provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY },
          },
          note: 'actually it was glipizide',
        },
      });
      const out = warnSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
      expect(out).not.toContain('metformin-PHI-MARKER-8686');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('CT: correction surfaces the dropped retract token so DAD-10 end-state is reachable', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-ct-'));
    try {
      const { pl, ledger } = makePl(tmp);
      await ledgerSeed(pl);
      const result = await pl.ingest({
        profileId: 'default',
        source: 'chat',
        kind: 'ledger-correction',
        payload: {
          wrong: { entity: 'metformin-PHI-MARKER-8686', type: 'medication' as const },
          corrected: {
            entity: 'glipizide', type: 'medication' as const, fields: { dose: '5mg' },
            provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY },
          },
          note: 'actually it was glipizide',
        },
      });
      expect(result).toMatchObject({ kind: 'applied' });
      // The retract token MUST be surfaced on the result (was swallowed pre-fix).
      const pendingRetract = (result as { pendingRetract?: { uuid: string } }).pendingRetract;
      expect(pendingRetract).toBeDefined();
      expect(typeof pendingRetract!.uuid).toBe('string');
      // DAD-10 end-state: confirming the relayed token retracts the mistaken fact.
      await ledger.confirm(pendingRetract!.uuid);
      const chain = await ledger.getChain('metformin-PHI-MARKER-8686', 'medication');
      expect(chain.some(f => f.status === 'retracted')).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/** Seed an active med fact through the pipeline (mirrors a real capture turn). */
async function ledgerSeed(pl: CapturePipeline): Promise<void> {
  await pl.ingest({
    profileId: 'default',
    source: 'chat',
    kind: 'ledger-fact',
    payload: {
      entity: 'metformin-PHI-MARKER-8686', type: 'medication' as const, fields: { dose: '500mg' },
      provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY },
    },
  });
}

describe('W-C/D fix pass — DS/A1: a minted dispute creates a follow-up curiosity item', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-curio-'));
  });
  afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  function buildPl() {
    const clock = mutableClock(DAY);
    const ledger = new LedgerStore(tmpRoot, clock);
    const narrative = new NarrativeStore(tmpRoot, clock);
    const view = new SafetyView(tmpRoot, clock);
    const curiosity = new CuriosityQueue(tmpRoot, clock, seqIdGen('cur'), 'default');
    const safety = {
      render: (facts: Parameters<typeof view.render>[0]) => view.render(facts),
      listSafetyRelevant: () => ledger.listSafetyRelevant(),
    };
    const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
    return { pl: new CapturePipeline({ queue, ledger, narrative, safety, curiosity, clock }), ledger, curiosity };
  }

  it('disputed ledger-fact → follow-up curiosity item tied to the entity, re-askable ~7d later', async () => {
    const { pl, curiosity } = buildPl();
    // Same-rank conflicting claims on a CONDITION → dispute (meds would confirm instead).
    await pl.ingest({
      profileId: 'default', source: 'chat', kind: 'ledger-fact',
      payload: {
        entity: 'migraine', type: 'condition' as const, fields: { frequency: 'weekly' },
        provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY },
      },
    });
    const result = await pl.ingest({
      profileId: 'default', source: 'chat', kind: 'ledger-fact',
      payload: {
        entity: 'migraine', type: 'condition' as const, fields: { frequency: 'daily' },
        provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY },
      },
    });
    expect(result).toMatchObject({ kind: 'disputed' });

    // A1: the queue must hold a follow-up item tied to the entity.
    const items = await curiosity.list();
    const item = items.find(i => i.kind === 'follow-up' && i.relatedEntity === 'migraine');
    expect(item).toBeDefined();
    // Non-med dispute → not critical (A1: critical iff med/allergy).
    expect(item!.critical ?? false).toBe(false);

    // Re-ask cadence: dueAt sits ~7d out from the capture day.
    expect(item!.dueAt).toBeDefined();
    const dueMs = new Date(item!.dueAt!).getTime();
    expect(dueMs - new Date(DAY).getTime()).toBeGreaterThanOrEqual(6.9 * 24 * 3600 * 1000);
    expect(dueMs - new Date(DAY).getTime()).toBeLessThanOrEqual(7.1 * 24 * 3600 * 1000);
  });

  it('applied facts create NO curiosity noise (the item is dispute-specific)', async () => {
    const { pl, curiosity } = buildPl();
    await pl.ingest({
      profileId: 'default', source: 'chat', kind: 'ledger-fact',
      payload: {
        entity: 'knee-injury', type: 'condition' as const, fields: { severity: 'mild' },
        provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY },
      },
    });
    const items = await curiosity.list();
    expect(items.some(i => i.relatedEntity === 'knee-injury')).toBe(false);
  });
});

describe('W-C/D fix pass — self-review IMPORTANT-4: pendingRetract survives a pending corrected arm', () => {
  afterEach(() => jest.restoreAllMocks());

  it('correction whose CORRECTED fact also needs confirmation still relays the retract token', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-ct2-'));
    try {
      const clock = mutableClock(DAY);
      const ledger = new LedgerStore(tmp, clock);
      const narrative = new NarrativeStore(tmp, clock);
      const view = new SafetyView(tmp, clock);
      const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
      const safety = {
        render: (facts: Parameters<typeof view.render>[0]) => view.render(facts),
        listSafetyRelevant: () => ledger.listSafetyRelevant(),
      };
      const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
      const pl = new CapturePipeline({ queue, ledger, narrative, safety, curiosity, clock });

      // Wrong entity = active MED (its retract will need confirmation)…
      await pl.ingest({
        profileId: 'default', source: 'chat', kind: 'ledger-fact',
        payload: {
          entity: 'ibuprofen-wrong', type: 'medication' as const, fields: { dose: '200mg' },
          provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY },
        },
      });
      // …and the corrected entity ALREADY exists with a conflicting med fact
      // (so its record arm ALSO returns needs-confirmation).
      await ledger.recordFact({
        entity: 'naproxen', type: 'medication', fields: { dose: '250mg' },
        provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY },
      });

      const result = await pl.ingest({
        profileId: 'default', source: 'chat', kind: 'ledger-correction',
        payload: {
          wrong: { entity: 'ibuprofen-wrong', type: 'medication' as const },
          corrected: {
            entity: 'naproxen', type: 'medication' as const, fields: { dose: '500mg' },
            provenance: { source: 'user', confidence: 0.9, anchor: '', capturedAt: DAY },
          },
          note: 'actually naproxen at 500',
        },
      });
      expect(result).toMatchObject({ kind: 'needs-confirmation' });
      // Pre-fix the retract token was dropped whenever corrected.kind !== applied.
      expect((result as { pendingRetract?: { uuid: string } }).pendingRetract).toBeDefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
