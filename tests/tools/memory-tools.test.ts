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

  it('memory_get returns a clean error for a traversal path', async () => {
    const tool = tools.find(t => t.name === 'memory_get')!;
    const result = await tool.execute({ path: '../SAFETY' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid path');
    expect(result.content[0].text).not.toContain('SAFETY');
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

  describe('append credential smuggling prevention', () => {
    it('rejects first append that directly contains a full credential', async () => {
      const tool = tools.find(t => t.name === 'memory_write')!;
      const result = await tool.execute({
        path: 'secrets.md',
        content: 'sk-abc123def456ghi789jkl012mno345pqr678',
        mode: 'append',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('credential');
    });

    it('rejects second append when combined with existing tail forms a credential', async () => {
      const tool = tools.find(t => t.name === 'memory_write')!;
      await engine.writeFile('creep.md', 'some prefix ');
      const first = await tool.execute({
        path: 'creep.md',
        content: 'sk-',
        mode: 'append',
      });
      expect(first.isError).toBeFalsy();

      const second = await tool.execute({
        path: 'creep.md',
        content: 'abc123def456ghi789jkl012mno345pqr678',
        mode: 'append',
      });
      expect(second.isError).toBe(true);
      expect(second.content[0].text).toContain('credential');
    });

    it('allows normal medical content even in append mode', async () => {
      const tool = tools.find(t => t.name === 'memory_write')!;

      const first = await tool.execute({
        path: 'health.md',
        content: 'Patient has type 2 diabetes. ',
        mode: 'append',
      });
      expect(first.isError).toBeFalsy();

      const second = await tool.execute({
        path: 'health.md',
        content: 'NDC 0093-7146-56, ICD-10 E11.9, take metformin 500mg.',
        mode: 'append',
      });
      expect(second.isError).toBeFalsy();
    });

    // SEC-M2b: the exact review exploit — a credential is smuggled across two
    // appends. Append 1 writes the label plus >8192 chars of '#' padding (no
    // value, so the tail-window pre-scan sees no credential). Append 2 writes
    // the value; the 8K tail window now contains only padding + value (label
    // pushed out), so the pre-scan passes — but the assembled file reconstructs
    // the credential. The fix re-reads the ENTIRE file after the append and, on
    // match, rolls the append back to the pre-append content and rejects.
    it('rejects the split-append exploit (label + >8192 # padding, then value) and restores the file', async () => {
      const tool = tools.find(t => t.name === 'memory_write')!;

      // Append 1: label + 8200 '#' padding. Not yet a credential.
      const first = await tool.execute({
        path: 'split.md',
        content: 'api_key = ' + '#'.repeat(8200),
        mode: 'append',
      });
      expect(first.isError).toBeFalsy();

      const afterFirst = await engine.readFile('split.md');
      expect(afterFirst).toContain('api_key =');
      expect(afterFirst).not.toContain('abcdefghijklmnopqrstuvwxyz123456');

      // Append 2: the value. The pre-scan sees only padding + value (no label)
      // so it passes — but the post-write full re-scan catches the assembled
      // credential, rolls the append back, and rejects.
      const second = await tool.execute({
        path: 'split.md',
        content: 'abcdefghijklmnopqrstuvwxyz123456',
        mode: 'append',
      });
      expect(second.isError).toBe(true);
      expect(second.content[0].text).toContain('credential');

      // The append was rolled back: the file content is unchanged from after
      // the first append (the value is NOT on disk).
      const afterSecond = await engine.readFile('split.md');
      expect(afterSecond).toBe(afterFirst);
      expect(afterSecond).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    });
  });
});
