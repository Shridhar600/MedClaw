import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemoryTools } from '../../src/tools/memory-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';
import type { MemorySearch } from '../../src/memory/search';

describe('Memory Tools', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let tools: ReturnType<typeof createMemoryTools>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-tools-'));
    engine = new MemoryEngine(tmpDir);
    tools = createMemoryTools(engine);
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('memory_get reads a file', async () => {
    await engine.writeFile('SOUL.md', '# Soul');
    const tool = tools.find(t => t.name === 'memory_get')!;
    const result = await tool.execute({ path: 'SOUL.md' });
    expect(result.content[0].text).toContain('# Soul');
    expect(result.isError).toBeFalsy();
  });

  it('memory_get returns error for missing file', async () => {
    const tool = tools.find(t => t.name === 'memory_get')!;
    const result = await tool.execute({ path: 'missing.md' });
    expect(result.isError).toBe(true);
  });

  it('memory_get returns a clear error for directory paths', async () => {
    fs.mkdirSync(path.join(tmpDir, 'medications'), { recursive: true });

    const tool = tools.find(t => t.name === 'memory_get')!;
    const result = await tool.execute({ path: 'medications' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Path is a directory');
    expect(result.content[0].text).toContain('medications');
  });

  it('memory_write creates a file', async () => {
    const tool = tools.find(t => t.name === 'memory_write')!;
    await tool.execute({ path: 'goals/bulking.md', content: '# Bulking Plan', mode: 'overwrite' });
    const content = await engine.readFile('goals/bulking.md');
    expect(content).toBe('# Bulking Plan');
  });

  it('memory_write appends when mode is append', async () => {
    const tool = tools.find(t => t.name === 'memory_write')!;
    await engine.writeFile('memory/today.md', '# Log\n');
    await tool.execute({ path: 'memory/today.md', content: '- Took meds\n', mode: 'append' });
    const content = await engine.readFile('memory/today.md');
    expect(content).toContain('- Took meds');
  });

  it('memory_search returns formatted results when search is available', async () => {
    const mockSearch = {
      search: jest.fn().mockResolvedValue([
        {
          chunkId: 'health.md:3',
          path: 'health.md',
          content: 'Blood sugar is 180',
          score: 0.95,
          startLine: 12,
          endLine: 18,
        },
      ]),
    };
    const toolsWithSearch = createMemoryTools(engine, mockSearch as unknown as MemorySearch);
    const tool = toolsWithSearch.find(t => t.name === 'memory_search')!;
    const result = await tool.execute({ query: 'blood sugar' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('health.md');
    expect(result.content[0].text).toContain('0.950');
    expect(result.content[0].text).toContain('Blood sugar is 180');
    expect(result.content[0].text).toContain('health.md:3');
    expect(result.content[0].text).toContain('12-18');
  });

  it('memory_search returns error when search is not available', async () => {
    const tool = tools.find(t => t.name === 'memory_search')!;
    const result = await tool.execute({ query: 'blood sugar' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Memory search not available');
  });
});
