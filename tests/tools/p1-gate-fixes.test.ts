// P1 gate-closer fix pass — tool-level regressions (audit SB-1, SB-3) + DAD-09 capture proof.
// Each behavior change was proven RED on p1-memory-core @ 941078d before its fix.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { LedgerStore, NarrativeStore, SafetyView, CuriosityQueue, EpisodeStore, renderLedgerFile } from '../../src/memcore';
import { CapturePipeline, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { createLedgerTools } from '../../src/tools/ledger-tools';
import { createEpisodeTools } from '../../src/tools/episode-tools';
import { mutableClock, seqIdGen, fact } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';

const DAY = '2026-08-22T10:00:00.000Z';
const SECRET = 'password: "hunter2hunter2hunter2x"'; // label + ≥16 alnum value

function harness(tmp: string): { ledger: LedgerStore; narrative: NarrativeStore; ledgerTools: Tool[]; episodeTools: Tool[] } {
  const clock = mutableClock(DAY);
  const ledger = new LedgerStore(tmp, clock);
  const narrative = new NarrativeStore(tmp, clock);
  const view = new SafetyView(tmp, clock);
  const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
  const safety = makeSafetyRenderer({ render: (facts) => view.render(facts), listSafetyRelevant: () => ledger.listSafetyRelevant() });
  const queue: QueuePort = { enqueue: async (_p, op) => op.run() };
  const pipeline = new CapturePipeline({ queue, ledger, narrative, safety, curiosity });
  const ledgerTools = createLedgerTools({ pipeline, ledger, safety, queue, clock, narrative });
  const episodeTools = createEpisodeTools({ store: new EpisodeStore(tmp), profileId: 'default' });
  return { ledger, narrative, ledgerTools, episodeTools };
}
const byName = (tools: Tool[]) => (n: string): Tool => tools.find(t => t.name === n)!;

describe('P1 gate fix — SB-1: episode lane rejects credentials like every other write path', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sb1-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('episode_manage create rejects a credential in the note and writes nothing', async () => {
    const { episodeTools } = harness(tmp);
    const r = await byName(episodeTools)('episode_manage').execute({ action: 'create', title: 'My doctor', note: `portal ${SECRET}` });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/credential|rejected/i);
    // Nothing persisted.
    const episodesDir = path.join(tmp, 'episodes');
    expect(fs.existsSync(episodesDir) ? fs.readdirSync(episodesDir) : []).toEqual([]);
  });

  it('a clean episode still creates (no over-rejection)', async () => {
    const { episodeTools } = harness(tmp);
    const r = await byName(episodeTools)('episode_manage').execute({ action: 'create', title: 'Knee arc', note: 'trek injury' });
    expect(r.isError).toBeFalsy();
  });
});

describe('P1 gate fix — SB-3: dual-active facts are DETECTED and surfaced (CONTRA-02)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sb3-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('ledger_query surfaces a conflict warning when an entity has >1 active version', async () => {
    const { ledger, ledgerTools } = harness(tmp);
    const day = DAY;
    const v1 = fact('metformin', 'medication', { version: 1, status: 'active', fields: { dose: '500mg' }, safetyRelevant: true, createdAt: day });
    const v3 = fact('metformin', 'medication', { version: 3, status: 'active', fields: { dose: '500mg' }, safetyRelevant: true, createdAt: day });
    fs.mkdirSync(path.join(tmp, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ledger', 'medications.md'), renderLedgerFile([v1, v3]));

    // Store-level detector.
    expect(await ledger.listActiveConflicts('medication')).toContain('metformin');

    // Tool-surfaced: the conflict is called out to the agent (not silently rendered as two facts).
    const q = await byName(ledgerTools)('ledger_query').execute({ type: 'medication' });
    expect(q.content[0].text).toMatch(/conflict/i);
    expect(q.content[0].text).toMatch(/metformin/);
  });
});

describe('P1 gate fix — DAD-09: terse acknowledgements are captured losslessly to the narrative lane', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-dad09-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('a one-word "ok" ack lands in the daily narrative (no-spam/adherence legs are P4)', async () => {
    const clock = mutableClock(DAY);
    const ledger = new LedgerStore(tmp, clock);
    const narrative = new NarrativeStore(tmp, clock);
    const view = new SafetyView(tmp, clock);
    const curiosity = new CuriosityQueue(tmp, clock, seqIdGen('cur'), 'default');
    const safety = makeSafetyRenderer({ render: (f) => view.render(f), listSafetyRelevant: () => ledger.listSafetyRelevant() });
    const pipeline = new CapturePipeline({ queue: { enqueue: async (_p, op) => op.run() }, ledger, narrative, safety, curiosity });

    await pipeline.ingest({ profileId: 'default', source: 'chat', kind: 'narrative-note', payload: { text: 'ok' } });

    const day = fs.readFileSync(path.join(tmp, 'memory', '2026-08-22.md'), 'utf8');
    expect(day).toContain('ok');
  });
});
