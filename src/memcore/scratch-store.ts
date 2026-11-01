
import * as fs from 'fs';
import type { Clock, IdGen } from '../ports';
import { systemClock, uuidIdGen } from '../ports';
import { contentContainsCredentials, secureWriteViaTmp, secureMkdir, summarizeErrorForLog, resolveContainedPath } from '../security';

/** Default note lifetime: 30 days. */
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ScratchNote {
  id: string;
  createdAt: string;
  content: string;
}

export interface ScratchStoreOptions {
  ttlMs?: number;
}

export interface PromotionScanResult {
  ok: boolean;
  reason?: 'credential' | 'injection';
  /** The first matching pattern source (a regex, never scanned content). */
  pattern?: string;
}

export const INJECTION_PATTERNS: RegExp[] = [
  // Direct instruction-override ("Ignore previous instructions…").
  /ignore\s+(?:all\s+|any\s+|your\s+)*(?:previous|prior|above|earlier)\s+(?:instructions|messages|prompts?|context|commands|rules)/i,
  /disregard\s+(?:all\s+|any\s+)*(?:previous|prior|above|earlier)\s+(?:instructions|messages|prompts?|context|commands|rules)/i,
  // Wipe-memory attempts ("forget everything you learned").
  /forget\s+(?:everything|all)\s+(?:you\s+)?(?:learned|instructions|previous|prior|above)/i,
  // Raw role-tag smuggling (<system>, <user>…).
  /<\s*\/?\s*(?:system|user|assistant)\s*>/i,
];

const CREATED_PREFIX = '<!-- created: ';

export class ScratchStore {
  private readonly ttlMs: number;

  constructor(
    private readonly rootDir: string,
    private readonly clock: Clock = systemClock,
    private readonly idGen: IdGen = uuidIdGen,
    opts?: ScratchStoreOptions,
  ) {
    secureMkdir(rootDir);
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  }

  private dirPath(): string {
    return resolveContainedPath(this.rootDir, 'scratch');
  }

  private filePath(id: string): string {
    return resolveContainedPath(this.rootDir, 'scratch', `${id}.md`);
  }

  async put(content: string): Promise<ScratchNote> {
    const note: ScratchNote = {
      id: this.idGen.newId(),
      createdAt: this.clock.now().toISOString(),
      content,
    };
    secureWriteViaTmp(this.filePath(note.id), this.render(note));
    return note;
  }

  async get(id: string): Promise<ScratchNote | null> {
    const fp = this.filePath(id);
    let content: string;
    try {
      content = fs.readFileSync(fp, 'utf-8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return null;
      console.warn(`[scratch-store] read failed for ${id}: ${summarizeErrorForLog(err)}`);
      return null;
    }
    try {
      return this.parse(id, content);
    } catch (err) {
      console.warn(`[scratch-store] corrupt scratch ${id} skipped: ${summarizeErrorForLog(err)}`);
      return null;
    }
  }

  async remove(id: string): Promise<boolean> {
    const fp = this.filePath(id);
    try {
      await fs.promises.unlink(fp);
      return true;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return false;
      console.warn(`[scratch-store] remove failed for ${id}: ${summarizeErrorForLog(err)}`);
      return false;
    }
  }

  /** All notes currently on disk. Corrupt notes are skipped with a warning. */
  async list(): Promise<ScratchNote[]> {
    const notes: ScratchNote[] = [];
    for (const id of this.listIds()) {
      const note = await this.get(id);
      if (note) notes.push(note);
    }
    return notes;
  }

  async sweep(): Promise<number> {
    const now = this.clock.now().getTime();
    let removed = 0;
    for (const id of this.listIds()) {
      let note: ScratchNote | null;
      try {
        note = await this.get(id);
      } catch {
        note = null;
      }
      if (!note) continue;
      const age = now - new Date(note.createdAt).getTime();
      if (age > this.ttlMs) {
        await this.remove(id);
        removed += 1;
      }
    }
    return removed;
  }

  scanForPromotion(content: string): PromotionScanResult {
    const cred = contentContainsCredentials(content);
    if (cred.matched) {
      return { ok: false, reason: 'credential', pattern: cred.pattern };
    }
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        return { ok: false, reason: 'injection', pattern: pattern.source.slice(0, 40) };
      }
    }
    return { ok: true };
  }

  private listIds(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dirPath());
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return [];
      console.warn(`[scratch-store] listing failed: ${summarizeErrorForLog(err)}`);
      return [];
    }
    return names.filter(n => n.endsWith('.md')).map(n => n.replace(/\.md$/, ''));
  }

  private render(note: ScratchNote): string {
    return `${CREATED_PREFIX}${note.createdAt} -->\n${note.content}\n`;
  }

  private parse(id: string, content: string): ScratchNote {
    const lines = content.split('\n');
    const createdLine = lines.shift() ?? '';
    if (!createdLine.startsWith(CREATED_PREFIX) || !createdLine.endsWith('-->')) {
      throw new Error(`no created header in ${id}`);
    }
    const createdAt = createdLine.slice(CREATED_PREFIX.length, -' -->'.length);
    return {
      id,
      createdAt,
      content: lines.join('\n').trimEnd(),
    };
  }
}
