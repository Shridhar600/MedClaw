import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLedgerTools } from '../../src/tools/ledger-tools';
import { LedgerStore, NarrativeStore, SafetyView, CuriosityQueue } from '../../src/memcore';
import { CapturePipeline, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';

const DAY = '2026-08-20T10:00:00.000Z';

// E1.2 — `ledger_record` exposes `replaces`/`corrects` so the capture path can set them; they thread
// schema → payload → pipeline → recordFact, and the store stamps the reverse link (M-6).
describe('ledger_record cross-link params (E1.2)', () => {
  let tmp: string;
  let ledger: LedgerStore;
  let tools: Tool[];
  const byName = (n: string): Tool => tools.find(t => t.name === n)!;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-record-crosslink-'));
    const clock = mutableClock(DAY);
    ledger = new LedgerStore(tmp, clock);
    const narrative = new NarrativeStore(tmp, clock);
    const view = new SafetyView(tmp, clock);
    const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    const safety = makeSafetyRenderer({ render: (facts) => view.render(facts), listSafetyRelevant: () => ledger.listSafetyRelevant() });
    const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
    const pipeline = new CapturePipeline({ queue, ledger, narrative, safety, curiosity });
    tools = createLedgerTools({ pipeline, ledger, safety, queue, clock });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('advertises replaces + corrects in its schema', () => {
    const props = byName('ledger_record').parameters.properties as Record<string, unknown>;
    expect(props.replaces).toBeDefined();
    expect(props.corrects).toBeDefined();
  });

  it('threads replaces through to the reverse link (schema→pipeline→recordFact→reconcile)', async () => {
    await byName('ledger_record').execute({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg' } });
    await byName('ledger_record').execute({ entity: 'naproxen', type: 'medication', fields: { dose: '500mg' }, replaces: 'ibuprofen' });

    expect((await ledger.getCrossLinks('naproxen', 'medication')).replaces).toContain('ibuprofen');
    expect((await ledger.getCrossLinks('ibuprofen', 'medication')).replacedBy).toContain('naproxen@v1');
  });
});
