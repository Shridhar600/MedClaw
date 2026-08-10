import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemoryTools } from '../../src/tools/memory-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';

describe('memory_list tool', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let tools: ReturnType<typeof createMemoryTools>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-list-tool-'));
    engine = new MemoryEngine(tmpDir);
    tools = createMemoryTools(engine);
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  function listTool() {
    const tool = tools.find(t => t.name === 'memory_list');
    if (!tool) throw new Error('memory_list tool not found');
    return tool;
  }

  it('lists files at root', async () => {
    await engine.writeFile('SOUL.md', '# Soul');
    await engine.writeFile('HEARTBEAT.md', '# Heartbeat');
    const result = await listTool().execute({});
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('SOUL.md');
    expect(text).toContain('HEARTBEAT.md');
  });

  it('lists files in a subdirectory', async () => {
    await engine.writeFile('conditions/diabetes.md', '# Diabetes');
    await engine.writeFile('conditions/knee.md', '# Knee');
    const result = await listTool().execute({ path: 'conditions' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toContain('conditions/diabetes.md');
    expect(text).toContain('conditions/knee.md');
  });

  it('returns "No files found" for empty directory', async () => {
    fs.mkdirSync(path.join(tmpDir, 'empty'), { recursive: true });
    const result = await listTool().execute({ path: 'empty' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('No files found');
  });

  it('returns "No files found" when no md files in workspace', async () => {
    const result = await listTool().execute({});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('No files found');
  });

  it('rejects path traversal via ".." in path', async () => {
    const result = await listTool().execute({ path: '..' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Path traversal');
  });

  it('rejects path traversal via "../" in path', async () => {
    const result = await listTool().execute({ path: '../secret' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Path traversal');
  });
});
