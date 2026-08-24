import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLedgerTools } from '../../src/tools/ledger-tools';
import { LedgerStore, NarrativeStore, SafetyView, CuriosityQueue } from '../../src/memcore';
import { CapturePipeline, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';
import type { FactType } from '../../src/memcore';
import type { Tool } from '../../src/tools/types';

const DAY = '2026-08-20T10:00:00.000Z';

// E2/CONTRA-09 regression: the confirm (`ledger_update`) and direct-apply (`ledger_remove`) paths
// bypass the capture pipeline, so they must fire `afterLedgerMutation` to re-derive the recall
// mirror — otherwise a confirmed retraction keeps injecting the stale fact into the next turn.
describe('ledger tools recall re-derive hook (E2 / CONTRA-09)', () => {
  let tmp: string;
  let tools: Tool[];
  let mutations: FactType[];
  const byName = (n: string): Tool => tools.find(t => t.name === n)!;
  const tokenOf = (text: string): string => (text.match(/tokenId="([0-9a-f-]+)"/) ?? [])[1]!;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-mutation-rederive-'));
    mutations = [];
    const clock = mutableClock(DAY);
    const ledger = new LedgerStore(tmp, clock);
    const narrative = new NarrativeStore(tmp, clock);
    const view = new SafetyView(tmp, clock);
    const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    const safety = makeSafetyRenderer({ render: (facts) => view.render(facts), listSafetyRelevant: () => ledger.listSafetyRelevant() });
    const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
    const pipeline = new CapturePipeline({ queue, ledger, narrative, safety, curiosity });
    tools = createLedgerTools({
      pipeline, ledger, safety, queue,
      afterLedgerMutation: async (type) => { mutations.push(type); },
    });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('fires on a confirmed medication retraction', async () => {
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' } });
    mutations.length = 0; // ignore the record path (pipeline re-derives that one)
    const rm = await byName('ledger_remove').execute({ entity: 'metformin', type: 'medication', reason: 'stopped' });
    await byName('ledger_update').execute({ tokenId: tokenOf(rm.content[0].text), confirm: true });
    expect(mutations).toContain('medication');
  });

  it('does NOT fire on a declined confirmation (no state change)', async () => {
    await byName('ledger_record').execute({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' } });
    const rm = await byName('ledger_remove').execute({ entity: 'metformin', type: 'medication', reason: 'stopped' });
    mutations.length = 0;
    await byName('ledger_update').execute({ tokenId: tokenOf(rm.content[0].text), confirm: false });
    expect(mutations).toHaveLength(0);
  });

  it('fires on a direct-applied (non-med) removal', async () => {
    await byName('ledger_record').execute({ entity: 'headache', type: 'symptom', fields: { severity: 'mild' } });
    mutations.length = 0;
    await byName('ledger_remove').execute({ entity: 'headache', type: 'symptom' });
    expect(mutations).toContain('symptom');
  });
});
