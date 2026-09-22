import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemoryTools } from '../../src/tools/memory-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';
import type { MemorySearch } from '../../src/memory/search';
import type { SearchResult } from '../../src/memory/types';
import type { Tool } from '../../src/tools/types';

// Task 12.7: memory_search v2 — optional `lane` filter (path-prefix) + the existing
// full|keyword-only|failed quality flag. `status` is accepted but a documented no-op (P2).
describe('memory_search v2 (lane filter)', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let searchTool: Tool;

  const canned: SearchResult[] = [
    { chunkId: 'c1', path: 'memory/2026-08-12.md', content: 'narrative hit', score: 0.9, startLine: 1, endLine: 2, status: 'full' },
    { chunkId: 'c2', path: 'ledger/medications.md', content: 'ledger hit', score: 0.8, startLine: 1, endLine: 2, status: 'full' },
    { chunkId: 'c3', path: 'conditions/diabetes.md', content: 'condition hit', score: 0.7, startLine: 1, endLine: 2, status: 'full' },
  ];
  const fakeSearch = { search: async (): Promise<SearchResult[]> => canned } as unknown as MemorySearch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-search2-'));
    engine = new MemoryEngine(tmpDir);
    searchTool = createMemoryTools(engine, fakeSearch).find(t => t.name === 'memory_search')!;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('exposes lane + status params in its schema', () => {
    const props = searchTool.parameters.properties as Record<string, unknown>;
    expect(props.lane).toBeDefined();
    expect(props.status).toBeDefined();
  });

  it('returns all lanes when no lane filter is given (backward-compat)', async () => {
    const r = await searchTool.execute({ query: 'x' });
    expect(r.content[0].text).toContain('narrative hit');
    expect(r.content[0].text).toContain('ledger hit');
    expect(r.content[0].text).toContain('condition hit');
  });

  it('filters to the narrative lane by path prefix', async () => {
    const r = await searchTool.execute({ query: 'x', lane: 'narrative' });
    expect(r.content[0].text).toContain('narrative hit');
    expect(r.content[0].text).not.toContain('ledger hit');
    expect(r.content[0].text).not.toContain('condition hit');
  });

  it('filters to the ledger lane', async () => {
    const r = await searchTool.execute({ query: 'x', lane: 'ledger' });
    expect(r.content[0].text).toContain('ledger hit');
    expect(r.content[0].text).not.toContain('narrative hit');
  });

  it('accepts a status param as a no-op (does not error, still returns results)', async () => {
    const r = await searchTool.execute({ query: 'x', status: 'active' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('narrative hit');
  });

  it('reports no results when a lane matches nothing', async () => {
    const r = await searchTool.execute({ query: 'x', lane: 'episode' });
    expect(r.content[0].text).toContain('No results found');
  });
});
