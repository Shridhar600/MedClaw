// src/memcore/episode-store.ts
//
// Episodes group related facts + narrative into one health arc (a knee-injury
// arc, a diabetes-management period — spec 03 §2.4). Each episode is one file
// `episodes/<id>.md`, Markdown as source of truth. This store is the P1
// write/read surface: CRUD + fact linking + a PAGED list (specs/16 §3 — the
// pager never parses the whole directory; it reads one page of filenames and
// parses only that page). Picking/recall logic is P2/P4 and does not live here.
//
// Corrupt episode files are skipped with a sanitized warning, never a crash (D2).

import * as fs from 'fs';
import * as path from 'path';
import type { Clock, IdGen } from '../ports';
import { systemClock, uuidIdGen } from '../ports';
import { secureWriteViaTmp, secureMkdir, summarizeErrorForLog } from '../security';

export type EpisodeStatus = 'open' | 'resolving' | 'resolved' | 'reopened';

export interface Episode {
  id: string;
  profileId: string;
  title: string;
  status: EpisodeStatus;
  createdAt: string;
  updatedAt: string;
  bodyRegions?: string[];
  /** Ledger fact ids linked to this episode (e.g. `ibuprofen@v1`). */
  linkedFactIds?: string[];
  note?: string;
}

export interface CreateEpisodeInput {
  title: string;
  profileId: string;
  status?: EpisodeStatus;
  bodyRegions?: string[];
  note?: string;
}

export interface UpdateEpisodePatch {
  title?: string;
  status?: EpisodeStatus;
  bodyRegions?: string[];
  note?: string;
}

export interface EpisodeListOptions {
  status?: EpisodeStatus;
  limit?: number;
  cursor?: string;
}

export interface EpisodePage {
  items: Episode[];
  nextCursor?: string;
}

export class EpisodeStore {
  constructor(
    private readonly rootDir: string,
    private readonly clock: Clock = systemClock,
    private readonly idGen: IdGen = uuidIdGen,
  ) {}

  private dirPath(): string {
    return path.join(this.rootDir, 'episodes');
  }

  private filePath(id: string): string {
    return path.join(this.dirPath(), `${id}.md`);
  }

  async create(input: CreateEpisodeInput): Promise<Episode> {
    const now = this.clock.now().toISOString();
    const id = this.idGen.newId();
    const episode: Episode = {
      id,
      profileId: input.profileId,
      title: input.title,
      status: input.status ?? 'open',
      createdAt: now,
      updatedAt: now,
      bodyRegions: input.bodyRegions,
      note: input.note,
    };
    this.write(episode);
    return episode;
  }

  async get(id: string): Promise<Episode | null> {
    const fp = this.filePath(id);
    let content: string;
    try {
      content = fs.readFileSync(fp, 'utf-8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return null;
      console.warn(`[episode-store] read failed for ${id}: ${summarizeErrorForLog(err)}`);
      return null;
    }
    try {
      return this.parse(id, content);
    } catch (err) {
      console.warn(`[episode-store] corrupt episode ${id} skipped: ${summarizeErrorForLog(err)}`);
      return null;
    }
  }

  async update(id: string, patch: UpdateEpisodePatch): Promise<Episode | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next: Episode = {
      ...current,
      title: patch.title ?? current.title,
      status: patch.status ?? current.status,
      bodyRegions: patch.bodyRegions ?? current.bodyRegions,
      note: patch.note !== undefined ? patch.note : current.note,
      updatedAt: this.clock.now().toISOString(),
    };
    this.write(next);
    return next;
  }

  /**
   * Link ledger fact ids to an episode. Idempotent: re-adding an id is a no-op.
   * Always bumps updatedAt so `list`/review sees the touch.
   */
  async link(id: string, factIds: string[]): Promise<Episode | null> {
    const current = await this.get(id);
    if (!current) return null;
    const merged = [...(current.linkedFactIds ?? [])];
    for (const factId of factIds) {
      if (!merged.includes(factId)) merged.push(factId);
    }
    const next: Episode = {
      ...current,
      linkedFactIds: merged,
      updatedAt: this.clock.now().toISOString(),
    };
    this.write(next);
    return next;
  }

  /**
   * SOFT-delete: move the episode file to `episodes/.trash/<id>.md` rather than
   * unlinking it. Health-context data (the note + fact links) is never hard-deleted
   * (the profile soft-delete rule); `list`/`get` exclude `.trash` naturally. Returns
   * false when the episode does not exist in the live lane.
   */
  async remove(id: string): Promise<boolean> {
    const src = this.filePath(id);
    if (!fs.existsSync(src)) return false;
    try {
      const trashDir = path.join(this.dirPath(), '.trash');
      secureMkdir(trashDir);
      fs.renameSync(src, path.join(trashDir, `${id}.md`)); // rename preserves the 0600 mode
      return true;
    } catch (err) {
      console.warn(`[episode-store] soft-delete failed for ${id}: ${summarizeErrorForLog(err)}`);
      return false;
    }
  }

  /**
   * Paged list over the sorted `episodes/` dir listing. Reads the dir ONCE for
   * names (cheap), then reads+parses files one at a time, stopping as soon as
   * `limit` matching episodes are collected — the full directory is never
   * materialized (specs/16 §3). `cursor` is the last-returned episode id; names
   * `<= cursor` are skipped. Corrupt files are skipped with a warning.
   */
  async list(opts?: EpisodeListOptions): Promise<EpisodePage> {
    const limit = opts?.limit ?? Number.MAX_SAFE_INTEGER;
    if (limit <= 0) return { items: [] }; // a non-positive limit is an empty page, never a crash
    const names = this.listNames();
    const items: Episode[] = [];
    for (const name of names) {
      if (items.length >= limit) break;
      const id = name.replace(/\.md$/, '');
      if (opts?.cursor && id <= opts.cursor) continue;
      const episode = await this.get(id);
      if (!episode) continue;
      if (opts?.status && episode.status !== opts.status) continue;
      items.push(episode);
    }
    const exhausted = items.length >= limit && this.hasMoreAfter(names, items);
    return exhausted ? { items, nextCursor: items[items.length - 1].id } : { items };
  }

  // ---- internals ---------------------------------------------------------

  private listNames(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dirPath());
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return [];
      console.warn(`[episode-store] listing failed: ${summarizeErrorForLog(err)}`);
      return [];
    }
    return names.filter(n => n.endsWith('.md')).sort();
  }

  private hasMoreAfter(names: string[], items: Episode[]): boolean {
    const last = items[items.length - 1].id;
    return names.some(n => n.replace(/\.md$/, '') > last);
  }

  private write(episode: Episode): void {
    secureWriteViaTmp(this.filePath(episode.id), this.render(episode));
  }

  private render(episode: Episode): string {
    const lines: string[] = [`# ${episode.title}`];
    lines.push(`- status: ${episode.status}`);
    lines.push(`- profileId: ${episode.profileId}`);
    lines.push(`- createdAt: ${episode.createdAt}`);
    lines.push(`- updatedAt: ${episode.updatedAt}`);
    if (episode.bodyRegions && episode.bodyRegions.length > 0) {
      lines.push(`- bodyRegions: [${episode.bodyRegions.join(', ')}]`);
    }
    if (episode.linkedFactIds && episode.linkedFactIds.length > 0) {
      lines.push(`- linkedFactIds: [${episode.linkedFactIds.join(', ')}]`);
    }
    if (episode.note) {
      lines.push('', episode.note);
    }
    return lines.join('\n') + '\n';
  }

  private parse(id: string, content: string): Episode {
    const lines = content.split('\n');
    const title = lines.find(l => l.startsWith('# '))?.slice(2).trim();
    if (!title) throw new Error(`no title in ${id}`);
    const meta: Record<string, string> = {};
    let inNote = false;
    const noteParts: string[] = [];
    for (const line of lines.slice(1)) {
      if (inNote) {
        noteParts.push(line);
        continue;
      }
      if (line.trim() === '') {
        inNote = true;
        continue;
      }
      const m = line.match(/^- ([A-Za-z]+): (.*)$/);
      if (m) meta[m[1]] = m[2].trim();
    }
    const status = meta['status'];
    const profileId = meta['profileId'];
    const createdAt = meta['createdAt'];
    const updatedAt = meta['updatedAt'];
    if (!status || !profileId || !createdAt || !updatedAt) {
      throw new Error(`missing metadata in ${id}`);
    }
    if (!(status in STATUS_SET)) throw new Error(`bad status '${status}' in ${id}`);
    const note = noteParts.join('\n').trim() || undefined;
    return {
      id,
      title,
      profileId,
      status: status as EpisodeStatus,
      createdAt,
      updatedAt,
      bodyRegions: parseArray(meta['bodyRegions']),
      linkedFactIds: parseArray(meta['linkedFactIds']),
      note,
    };
  }
}

const STATUS_SET: Record<string, true> = {
  open: true, resolving: true, resolved: true, reopened: true,
};

function parseArray(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!raw.startsWith('[') || !raw.endsWith(']')) throw new Error(`bad array '${raw}'`);
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return undefined;
  return inner.split(',').map(s => s.trim());
}