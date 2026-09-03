// src/tools/episode-tools.ts
//
// episode_manage (Task 12.4) — CRUD over EpisodeStore (create/update/link/close/get/list
// with pagination). Episodes group related facts + narrative into a health arc.

import type { Tool, ToolResult } from './types';
import type { EpisodeStore, Episode, EpisodeStatus } from '../memcore';
import type { QueuePort } from '../capture';
import { contentContainsCredentials, PathContainmentError } from '../security';

const EPISODE_STATUSES: EpisodeStatus[] = ['open', 'resolving', 'resolved', 'reopened'];

export interface EpisodeToolsDeps {
  store: EpisodeStore;
  profileId: string;
  /**
   * RR-STRUCT R-S3 (C-46 generalization): `episode_manage` used to write DIRECTLY to
   * `EpisodeStore` — one file per episode id, read-then-write — with no serialization against a
   * concurrent mutation of the SAME episode (a genuine lost-update race). Routing create/update/
   * link/close through the single-writer coordinator closes that window. Optional + falls back to
   * the direct (pre-R-S3) call when absent, so existing single-caller test construction is
   * unaffected — a missing coordinator degrades atomicity, never availability (resilience law).
   */
  queue?: QueuePort;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function isPathContainmentError(error: unknown): boolean {
  return error instanceof PathContainmentError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_PATH_CONTAINMENT');
}

/**
 * SB-1: the episode lane persists caller-controlled text (title/note/regions/factIds) to a 0600
 * health file — it carries the SAME credential-rejection bar as every other write path
 * (memory_write, ledger_record, safety_note, capture). Returns a rejection or null.
 */
function scanEpisodeInputs(...fields: (string | string[] | undefined)[]): ToolResult | null {
  const text = fields.flatMap(f => (f === undefined ? [] : Array.isArray(f) ? f : [f])).join('\n');
  const cred = contentContainsCredentials(text);
  if (cred.matched) {
    return err(`Write rejected: content matches credential pattern (${cred.pattern}). Credentials must never be stored in the health memory.`);
  }
  return null;
}

function renderEpisode(e: Episode): string {
  const parts = [`${e.title} [${e.id}] status=${e.status}`];
  if (e.bodyRegions?.length) parts.push(`regions=${e.bodyRegions.join(',')}`);
  if (e.linkedFactIds?.length) parts.push(`facts=${e.linkedFactIds.join(',')}`);
  if (e.note) parts.push(`note=${e.note}`);
  return `- ${parts.join(' · ')}`;
}

export function createEpisodeTools(deps: EpisodeToolsDeps): Tool[] {
  // Serialize every mutating action against the SAME per-profile single-writer used by every
  // other memory-domain writer (RR-STRUCT R-S3). Without an injected queue, run inline — the
  // exact pre-R-S3 behavior (fine for a single caller; loses atomicity under real concurrency).
  const mutate = <T>(label: string, run: () => Promise<T>): Promise<T> =>
    deps.queue ? deps.queue.enqueue('turn', { label, scope: 'episode', run }) : run();

  const episodeManage: Tool = {
    name: 'episode_manage',
    group: 'group:episode',
    description: 'Manage health episodes (arcs grouping related facts/narrative): create, update, link facts, close, get, or list.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'link', 'close', 'get', 'list'], description: 'Operation' },
        id: { type: 'string', description: 'Episode id (for update/link/close/get)' },
        title: { type: 'string', description: 'Episode title (create/update)' },
        status: { type: 'string', enum: EPISODE_STATUSES, description: 'Episode status (create/update/list filter)' },
        bodyRegions: { type: 'array', items: { type: 'string' }, description: 'Affected body regions' },
        note: { type: 'string', description: 'Free-text note' },
        factIds: { type: 'array', items: { type: 'string' }, description: 'Ledger fact ids to link (action=link)' },
        limit: { type: 'number', description: 'Page size (action=list)' },
        cursor: { type: 'string', description: 'Pagination cursor (action=list)' },
      },
      required: ['action'],
    },
    async execute(params): Promise<ToolResult> {
      const action = params.action as string;
      const id = params.id as string | undefined;

      try {
        switch (action) {
        case 'create': {
          const title = params.title as string | undefined;
          if (!title) return err('episode_manage create needs a title.');
          const credCreate = scanEpisodeInputs(title, params.note as string | undefined, params.bodyRegions as string[] | undefined);
          if (credCreate) return credCreate;
          const episode = await mutate('episode:create', () => deps.store.create({
            title,
            profileId: deps.profileId,
            status: params.status as EpisodeStatus | undefined,
            bodyRegions: params.bodyRegions as string[] | undefined,
            note: params.note as string | undefined,
          }));
          return ok(`Created episode:\n${renderEpisode(episode)}`);
        }
        case 'update': {
          if (!id) return err('episode_manage update needs an id.');
          const credUpdate = scanEpisodeInputs(params.title as string | undefined, params.note as string | undefined, params.bodyRegions as string[] | undefined);
          if (credUpdate) return credUpdate;
          const updated = await mutate('episode:update', () => deps.store.update(id, {
            title: params.title as string | undefined,
            status: params.status as EpisodeStatus | undefined,
            bodyRegions: params.bodyRegions as string[] | undefined,
            note: params.note as string | undefined,
          }));
          return updated ? ok(`Updated:\n${renderEpisode(updated)}`) : err(`Episode not found: ${id}`);
        }
        case 'link': {
          if (!id) return err('episode_manage link needs an id.');
          const factIds = (params.factIds as string[] | undefined) ?? [];
          const credLink = scanEpisodeInputs(factIds);
          if (credLink) return credLink;
          const linked = await mutate('episode:link', () => deps.store.link(id, factIds));
          return linked ? ok(`Linked:\n${renderEpisode(linked)}`) : err(`Episode not found: ${id}`);
        }
        case 'close': {
          if (!id) return err('episode_manage close needs an id.');
          const closed = await mutate('episode:close', () => deps.store.update(id, { status: 'resolved' }));
          return closed ? ok(`Closed:\n${renderEpisode(closed)}`) : err(`Episode not found: ${id}`);
        }
        case 'get': {
          if (!id) return err('episode_manage get needs an id.');
          const episode = await deps.store.get(id);
          return episode ? ok(renderEpisode(episode)) : err(`Episode not found: ${id}`);
        }
        case 'list': {
          const page = await deps.store.list({
            status: params.status as EpisodeStatus | undefined,
            limit: params.limit as number | undefined,
            cursor: params.cursor as string | undefined,
          });
          const body = page.items.length ? page.items.map(renderEpisode).join('\n') : 'No episodes.';
          const cursorLine = page.nextCursor ? `\n(next cursor: ${page.nextCursor})` : '';
          return ok(body + cursorLine);
        }
          default:
            return err(`Unknown episode_manage action "${action}".`);
        }
      } catch (error) {
        if (isPathContainmentError(error)) {
          return err('Invalid id/date: it must not contain path separators or "..".');
        }
        throw error;
      }
    },
  };

  return [episodeManage];
}
