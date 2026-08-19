// src/memcore/curiosity-queue.ts
//
// Minimal durable curiosity queue: open follow-up / hypothesis items at
// `curiosity.md` (D7). P4's proactive engine will PICK from this queue; in P1
// we build only the store surface — add/list/resolve. No picking logic.
//
// G13: `CuriosityItem` is expected to grow in P4 (priority, evidence, expiry).
// This store persists ONLY the current fields; a `- resolvedAt:` line is a
// STORAGE-LEVEL marker appended on resolve (so resolution history survives and
// `list()` simply excludes resolved items) — it is NOT a CuriosityItem field
// and nothing here makes the P1 shape load-bearing for picking.
//
// The single-file format degrades safely: a corrupt block is skipped with a
// sanitized warning, never a crash (D2).

import * as fs from 'fs';
import * as path from 'path';
import type { Clock, IdGen } from '../ports';
import { systemClock, uuidIdGen } from '../ports';
import type { CuriosityItem, CuriosityKind } from './types';
import { secureWriteViaTmp, summarizeErrorForLog } from '../security';

export type AddCuriosityInput = Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'>;

export class CuriosityQueue {
  constructor(
    private readonly rootDir: string,
    private readonly clock: Clock = systemClock,
    private readonly idGen: IdGen = uuidIdGen,
    private readonly profileId: string = 'default',
  ) {}

  private filePath(): string {
    return path.join(this.rootDir, 'curiosity.md');
  }

  async add(input: AddCuriosityInput): Promise<CuriosityItem> {
    const now = this.clock.now().toISOString();
    const item: CuriosityItem = {
      ...input,
      id: this.idGen.newId(),
      profileId: this.profileId,
      createdAt: now,
    };
    const existing = this.readRaw();
    const content = existing === '' ? existing : `${existing}\n`;
    secureWriteViaTmp(this.filePath(), `${content}${renderBlock(item)}\n`);
    return item;
  }

  /** Active (unresolved) items, in insertion order. Corrupt blocks are skipped. */
  async list(): Promise<CuriosityItem[]> {
    const items: CuriosityItem[] = [];
    for (const block of this.parseBlocks(this.readRaw())) {
      if (block.meta['resolvedAt'] !== undefined) continue;
      try {
        items.push(toItem(block));
      } catch (err) {
        // PHI-safe: the block id is parsed from a `## <heading>` content line, so it
        // must NEVER be logged — a corrupt heading could carry health content.
        console.warn(`[curiosity-queue] corrupt curiosity item skipped: ${summarizeErrorForLog(err)}`);
      }
    }
    return items;
  }

  /**
   * Mark an item resolved (durable). Returns true when an unresolved item was
   * found and marked; false for an unknown or already-resolved id.
   */
  async resolve(id: string): Promise<boolean> {
    const lines = this.readRaw().split('\n');
    // Locate the target block by its `## <id>` heading.
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^## (.+)$/);
      if (m && m[1].trim() === id) { start = i; break; }
    }
    if (start < 0) return false;
    // The block runs until the next heading or EOF.
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) { end = i; break; }
    }
    // Already resolved?
    for (let i = start; i < end; i++) {
      if (/^- resolvedAt:/.test(lines[i])) return false;
    }
    // Insert the marker at the end of the block, preserving every other line verbatim
    // (unknown/forward-compat keys AND free-floating content survive — no full rewrite).
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, `- resolvedAt: ${this.clock.now().toISOString()}`);
    secureWriteViaTmp(this.filePath(), `${lines.join('\n').replace(/\n+$/, '')}\n`);
    return true;
  }

  // ---- internals ---------------------------------------------------------

  private readRaw(): string {
    try {
      return fs.readFileSync(this.filePath(), 'utf-8').replace(/\n+$/, '\n');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return '';
      console.warn(`[curiosity-queue] read failed: ${summarizeErrorForLog(err)}`);
      return '';
    }
  }

  private parseBlocks(content: string): ParsedBlock[] {
    const blocks: ParsedBlock[] = [];
    let current: ParsedBlock | null = null;
    for (const line of content.split('\n')) {
      const heading = line.match(/^## (.+)$/);
      if (heading) {
        current = { id: heading[1].trim(), meta: {} };
        blocks.push(current);
        continue;
      }
      if (!current) continue;
      const kv = line.match(/^- ([A-Za-z]+): (.*)$/);
      if (kv) current.meta[kv[1]] = kv[2].trim();
    }
    return blocks;
  }
}

interface ParsedBlock {
  id: string;
  meta: Record<string, string>;
}

const KINDS: Record<string, true> = {
  'follow-up': true, 'medication-reminder': true, 'lab-correlation': true,
  'information-gap': true, insight: true,
};

function toItem(block: ParsedBlock): CuriosityItem {
  const kind = block.meta['kind'];
  const profileId = block.meta['profileId'];
  const description = block.meta['description'];
  const createdAt = block.meta['createdAt'];
  if (!kind || !profileId || !description || !createdAt) {
    throw new Error(`missing metadata in ${block.id}`);
  }
  if (!(kind in KINDS)) throw new Error(`bad kind '${kind}' in ${block.id}`);
  const item: CuriosityItem = {
    id: block.id,
    profileId,
    kind: kind as CuriosityKind,
    description,
    createdAt,
  };
  if (block.meta['critical'] === 'true') item.critical = true;
  if (block.meta['relatedEntity']) item.relatedEntity = block.meta['relatedEntity'];
  if (block.meta['dueAt']) item.dueAt = block.meta['dueAt'];
  return item;
}

/** Collapse newlines so a scalar value can never inject a new `## ` block on re-parse. */
function s(v: string): string {
  return v.replace(/[\r\n]+/g, ' ');
}

function renderBlock(item: CuriosityItem): string {
  const lines = [`## ${item.id}`, `- kind: ${item.kind}`, `- profileId: ${item.profileId}`, `- description: ${s(item.description)}`, `- createdAt: ${item.createdAt}`];
  if (item.critical) lines.push('- critical: true');
  if (item.relatedEntity) lines.push(`- relatedEntity: ${s(item.relatedEntity)}`);
  if (item.dueAt) lines.push(`- dueAt: ${s(item.dueAt)}`);
  return lines.join('\n');
}