// tests/memory/memory-engine.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryEngine } from '../../src/memory/memory-engine';

describe('MemoryEngine', () => {
  let tmpDir: string;
  let engine: MemoryEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-mem-'));
    engine = new MemoryEngine(tmpDir);
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('writes and reads a file', async () => {
    await engine.writeFile('SOUL.md', '# Soul\nYou are a health companion.');
    const content = await engine.readFile('SOUL.md');
    expect(content).toBe('# Soul\nYou are a health companion.');
  });

  it('creates subdirectories on write', async () => {
    await engine.writeFile('conditions/diabetes.md', '# Diabetes');
    const content = await engine.readFile('conditions/diabetes.md');
    expect(content).toBe('# Diabetes');
  });

  it('returns null when file does not exist', async () => {
    const content = await engine.readFile('missing.md');
    expect(content).toBeNull();
  });

  it('appends to an existing file', async () => {
    await engine.writeFile('memory/2026-04-13.md', '# Log\n');
    await engine.appendToFile('memory/2026-04-13.md', '- Had breakfast\n');
    const content = await engine.readFile('memory/2026-04-13.md');
    expect(content).toBe('# Log\n- Had breakfast\n');
  });

  it('lists files in a directory', async () => {
    await engine.writeFile('conditions/diabetes.md', '#d');
    await engine.writeFile('conditions/knee.md', '#k');
    const files = await engine.listFiles('conditions');
    expect(files.sort()).toEqual(['conditions/diabetes.md', 'conditions/knee.md']);
  });

  it('lists files recursively', async () => {
    await engine.writeFile('memory/2026-04-12.md', 'a');
    await engine.writeFile('memory/2026-04-13.md', 'b');
    const files = await engine.listFiles('memory');
    expect(files).toHaveLength(2);
  });
});
