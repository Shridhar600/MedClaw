// src/memory/memory-engine.ts
import * as fs from 'fs';
import * as path from 'path';

// Methods are async by interface even though they use synchronous fs operations.
// This keeps callers future-proof if we switch to fs.promises without API changes.
export class MemoryEngine {
  constructor(
    private readonly workspace: string,
    private readonly profileId: string = 'default',
  ) {
    fs.mkdirSync(workspace, { recursive: true });
  }

  private resolve(relativePath: string): string {
    const full = path.join(this.workspace, relativePath);
    // Prevent path traversal — ensure resolved path stays within workspace
    if (!full.startsWith(this.workspace + path.sep) && full !== this.workspace) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    return full;
  }

  async readFile(relativePath: string): Promise<string | null> {
    const fullPath = this.resolve(relativePath);
    if (!fs.existsSync(fullPath)) return null;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${relativePath}`);
    }
    if (!stat.isFile()) return null;
    return fs.readFileSync(fullPath, 'utf8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolve(relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  async appendToFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolve(relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.appendFileSync(fullPath, content, 'utf8');
  }

  async listFiles(relativeDir: string = ''): Promise<string[]> {
    const fullDir = this.resolve(relativeDir);
    if (!fs.existsSync(fullDir)) return [];
    return this.walk(fullDir, relativeDir);
  }

  private walk(dir: string, relativeBase: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        results.push(...this.walk(path.join(dir, entry.name), relPath));
      } else if (entry.name.endsWith('.md')) {
        results.push(relPath);
      }
    }
    return results;
  }
}
