import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemoryTools } from '../../src/tools/memory-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';
import type { MemorySearch } from '../../src/memory/search';
import type { SearchResult } from '../../src/memory/types';
import type { FactMirror, FactRecord } from '../../src/ports';
import type { Tool } from '../../src/tools/types';

// E1.1 — CONTRA-06 / CONTRA-08. memory_search is chunk/hybrid search over Markdown (NOT a
// fact-version query — version ordering lives in ledger_query). Its `status` filter therefore
// means: `active` (the default) drops chunks whose derived ledger entity head is stale
// (retracted/discontinued/superseded); `all` disables that filter. This is the same stale-drop
// the recall engine applies in Stage-2 (chunkHasStaleEntity), so the two paths agree.

function headRec(entity: string, status: string, extra: Partial<FactRecord> = {}): FactRecord {
  return {
    id: `${entity}-head`, profileId: 'p1', entity, type: 'medication', version: 4,
    status, fields: {}, safetyRelevant: false, authority: 'user', confidence: 1,
    createdAt: '2026-08-05T00:00:00.000Z', ...extra,
  };
}

// A FactMirror whose only meaningful method is queryEntityHeads (the head-status source).
function makeMirror(heads: FactRecord[], opts: { throws?: boolean } = {}): FactMirror {
  async function* headsGen(): AsyncIterable<FactRecord> {
    if (opts.throws) throw new Error('mirror down');
    for (const h of heads) yield h;
  }
  return {
    upsert: async () => {},
    queryActive: async function* () {},
    queryPaused: async function* () {},
    queryEntityHeads: headsGen,
    rebuild: async () => {},
  };
}

const canned: SearchResult[] = [
  { chunkId: 'c1', path: 'ledger/medications.md', content: 'metformin — discontinued 2026-08-05 (per doctor). History: 850mg (Jul 22-Aug 5).', score: 0.9, startLine: 1, endLine: 2, status: 'full' },
  { chunkId: 'c2', path: 'ledger/medications.md', content: 'lisinopril 10mg daily (active)', score: 0.8, startLine: 3, endLine: 4, status: 'full' },
];
const fakeSearch = { search: async (): Promise<SearchResult[]> => canned } as unknown as MemorySearch;

describe('memory_search status filter (CONTRA-06/08)', () => {
  let tmpDir: string;
  let engine: MemoryEngine;

  const staleHeads = [headRec('metformin', 'discontinued'), headRec('lisinopril', 'active')];
  const tool = (mirror?: FactMirror): Tool =>
    createMemoryTools(engine, fakeSearch, undefined, 'p1', mirror).find(t => t.name === 'memory_search')!;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-search-status-'));
    engine = new MemoryEngine(tmpDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('advertises status active|all in its schema', () => {
    const props = tool(makeMirror(staleHeads)).parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.status.enum).toEqual(expect.arrayContaining(['active', 'all']));
  });

  it('status:active drops chunks whose entity head is stale (CONTRA-06)', async () => {
    const r = await tool(makeMirror(staleHeads)).execute({ query: 'metformin', status: 'active' });
    expect(r.content[0].text).not.toContain('metformin');
    expect(r.content[0].text).toContain('lisinopril');
  });

  it('defaults to active when status is omitted', async () => {
    const r = await tool(makeMirror(staleHeads)).execute({ query: 'metformin' });
    expect(r.content[0].text).not.toContain('metformin');
    expect(r.content[0].text).toContain('lisinopril');
  });

  it('status:all returns stale chunks too', async () => {
    const r = await tool(makeMirror(staleHeads)).execute({ query: 'metformin', status: 'all' });
    expect(r.content[0].text).toContain('metformin');
    expect(r.content[0].text).toContain('lisinopril');
  });

  it('degrades to no filtering when no fact mirror is wired', async () => {
    const r = await tool(undefined).execute({ query: 'metformin', status: 'active' });
    expect(r.content[0].text).toContain('metformin');
  });

  it('degrades to no filtering (never crashes) when the mirror throws', async () => {
    const r = await tool(makeMirror(staleHeads, { throws: true })).execute({ query: 'metformin', status: 'active' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('metformin');
  });

  it('accepts a lazy mirror accessor (gateway wiring shape)', async () => {
    const getMirror = () => makeMirror(staleHeads);
    const t = createMemoryTools(engine, fakeSearch, undefined, 'p1', getMirror).find(x => x.name === 'memory_search')!;
    const r = await t.execute({ query: 'metformin', status: 'active' });
    expect(r.content[0].text).not.toContain('metformin');
  });
});
