import * as fs from 'fs';
import { LedgerStore, NarrativeStore, SafetyView, CuriosityQueue } from '../../src/memcore';
import { CapturePipeline, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';
import type { Provenance } from '../../src/memcore/types';
import { makeTestTemp } from '../helpers/test-temp';

const DAY = '2026-08-20T10:00:00.000Z';
const userProv: Provenance = { source: 'user', confidence: 1, anchor: '', capturedAt: DAY, note: '' };

describe('CapturePipeline re-derives the recall mirror on a disputed mint', () => {
  let tmp: string;
  let pipeline: CapturePipeline;
  let rederiveCalls: string[][];

  beforeEach(() => {
    tmp = makeTestTemp('redacted-dispute-rederive-');
    const clock = mutableClock(DAY);
    const ledger = new LedgerStore(tmp, clock);
    const narrative = new NarrativeStore(tmp, clock);
    const view = new SafetyView(tmp, clock);
    const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    const safety = makeSafetyRenderer({ render: (f) => view.render(f), listSafetyRelevant: () => ledger.listSafetyRelevant() });
    const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
    rederiveCalls = [];
    const rederive = { rederive: async (paths: string[]): Promise<void> => { rederiveCalls.push(paths); } };
    pipeline = new CapturePipeline({ queue, ledger, narrative, safety, curiosity, rederive });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const record = (fields: Record<string, string>): Promise<unknown> => pipeline.ingest({
    kind: 'ledger-fact',
    payload: { entity: 'headache', type: 'symptom', fields, provenance: userProv },
  });

  it('pushes the ledger path to the rederive set when a same-authority conflict mints a dispute', async () => {
    await record({ severity: 'mild' });   // applied
    const result = await record({ severity: 'severe' }); // same-authority conflict → disputed

    expect((result as { kind?: string })?.kind ?? 'void').toBe('disputed');
    const disputedCall = rederiveCalls[rederiveCalls.length - 1];
    expect(disputedCall.some(p => p.includes('ledger/'))).toBe(true);
  });
});
