// src/memory/memory-engine.ts
import * as fs from 'fs';
import * as path from 'path';
import { secureMkdir, secureWrite, secureAppend } from '../security';

// Methods are async by interface even though they use synchronous fs operations.
// This keeps callers future-proof if we switch to fs.promises without API changes.
export class MemoryEngine {
  constructor(
    private readonly workspace: string,
    private readonly profileId: string = 'default',
  ) {
    secureMkdir(workspace);
    // Eagerly resolve the real workspace path to prevent a TOCTOU window
    // between construction and the first resolve() call.
    void this.realWorkspace;
  }

  // Cached on first access — the workspace doesn't change during the engine's lifetime.
  private _realWorkspace: string | undefined;

  private get realWorkspace(): string {
    if (this._realWorkspace === undefined) {
      this._realWorkspace = fs.realpathSync(this.workspace);
    }
    return this._realWorkspace;
  }

  private resolve(relativePath: string): string {
    const full = path.join(this.workspace, relativePath);
    // Prevent path traversal — ensure resolved path stays within workspace
    if (!full.startsWith(this.workspace + path.sep) && full !== this.workspace) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    // Symlink/TOCTOU guard — resolve the parent directory (or file itself) to
    // detect symlinks that point outside the real workspace root.
    const checkTarget = fs.existsSync(full) ? full : this.nearestExistingParent(full);
    const realTarget = fs.realpathSync(checkTarget);
    const realRoot = this.realWorkspace;
    if (
      !realTarget.startsWith(realRoot + path.sep) &&
      realTarget !== realRoot
    ) {
      throw new Error(`Path traversal detected: ${relativePath} (symlink outside workspace)`);
    }
    return full;
  }

  private nearestExistingParent(targetPath: string): string {
    let current = path.dirname(targetPath);
    while (current && current !== path.parse(current).root) {
      if (fs.existsSync(current)) {
        return current;
      }
      current = path.dirname(current);
    }
    return current;
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
    secureMkdir(path.dirname(fullPath));
    secureWrite(fullPath, content);
  }

  async appendToFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolve(relativePath);
    secureMkdir(path.dirname(fullPath));
    secureAppend(fullPath, content);
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
