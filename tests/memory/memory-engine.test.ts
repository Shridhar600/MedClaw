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

  it('rejects reading a path with ".." (traversal)', async () => {
    await expect(engine.readFile('../outside.txt')).rejects.toThrow('Path traversal');
  });

  it('rejects writing a path with ".." (traversal)', async () => {
    await expect(engine.writeFile('../outside.txt', 'bad')).rejects.toThrow('Path traversal');
  });

  // SEC-m1: absolute paths are explicitly rejected (defense-in-depth). path.join
  // would otherwise normalize them inside the workspace, which is safe but
  // surprising — callers expect absolute paths to be refused.
  it('rejects reading an absolute path with a clear error', async () => {
    await expect(engine.readFile('/etc/passwd')).rejects.toThrow('Absolute paths are not allowed');
  });

  it('rejects writing an absolute path with a clear error', async () => {
    await expect(engine.writeFile('/etc/passwd', 'bad')).rejects.toThrow('Absolute paths are not allowed');
  });

  it('rejects appending an absolute path with a clear error', async () => {
    await expect(engine.appendToFile('/etc/passwd', 'bad')).rejects.toThrow('Absolute paths are not allowed');
  });

  describe('symlink guard (TOCTOU)', () => {
    it('rejects read through a symlink pointing outside workspace', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-outside-'));
      try {
        const outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'outside content', 'utf-8');
        const symlinkPath = path.join(tmpDir, 'evil-link.txt');
        fs.symlinkSync(outsideFile, symlinkPath);

        await expect(engine.readFile('evil-link.txt')).rejects.toThrow('symlink outside workspace');
      } finally {
        fs.rmSync(outsideDir, { recursive: true });
      }
    });

    it('rejects write through a directory symlink pointing outside workspace', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-outside-'));
      try {
        const symlinkPath = path.join(tmpDir, 'evil-dir');
        fs.symlinkSync(outsideDir, symlinkPath, 'dir');

        await expect(engine.writeFile('evil-dir/bad.md', 'bad')).rejects.toThrow('symlink outside workspace');
      } finally {
        fs.rmSync(outsideDir, { recursive: true });
      }
    });

    it('allows read/write of normal nested paths (realpath on both sides)', async () => {
      await engine.writeFile('conditions/diabetes.md', '# Diabetes');
      const content = await engine.readFile('conditions/diabetes.md');
      expect(content).toBe('# Diabetes');
    });

    it('allows write to a new path within workspace (parent exists)', async () => {
      await engine.writeFile('conditions/knee.md', '# Knee pain');
      const content = await engine.readFile('conditions/knee.md');
      expect(content).toBe('# Knee pain');
    });
  });

});
