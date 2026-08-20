import type { Tool, ToolResult } from './types';
import type { MemoryEngine } from '../memory/memory-engine';
import type { MemorySearch } from '../memory/search';
import type { MemoryIndexer } from '../memory/indexer';
import { contentContainsCredentials, summarizeErrorForLog } from '../security';

// --- Managed-lane write guard (Task 12.6 / G1) -------------------------------------------
// `memory_write` must never raw-overwrite an invariant-bearing managed path — that would
// bypass versioning/confirmation (ledger), the 60/20/20 budget (MEMORY.md), the SAFETY.md
// non-removal rule (CONTRA-03/04), or a store's ownership. The narrative lane (`memory/**`)
// and core files (SOUL/USER/HEALTH_PROFILE/…) stay writable — the lossless guarantee lives
// in the Task 13.3 capture hook, not a block.

// memory_search v2 lane → path-prefix mapping (Task 12.7).
const LANE_PREFIX: Record<string, string> = {
  narrative: 'memory/',
  ledger: 'ledger/',
  episode: 'episodes/',
  digest: 'digest/',
  archive: 'archive/',
};

const MANAGED_REJECT = {
  ledger: 'Direct writes to the versioned ledger are not allowed. Use ledger_record / ledger_update — versioning, med-class confirmation, and SAFETY.md re-render (D8) live there.',
  memoryMd: 'Direct writes to MEMORY.md are not allowed — it is managed by the curated-memory budget engine (Health 60 / Life 20 / Agent 20).',
  safetyDrop: (entity: string): string =>
    `Refused: this SAFETY.md overwrite would drop the base allergy/medication entry "${entity}". Removal requires user confirmation — route it through ledger_update (CONTRA-03/04).`,
  episodes: 'Direct writes to episodes/ are not allowed. Use episode_manage.',
  curiosity: 'Direct writes to curiosity.md are not allowed (owned by the curiosity queue).',
  state: 'Direct writes to .state/ are not allowed (owned by the scheduler/store internals).',
  scratch: 'Direct writes to scratch/ are not allowed via memory_write.',
} as const;

function normalizeManagedPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function rejection(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Entity names listed under SAFETY.md's `## Allergies` / `## Medications` sections, lower-cased. */
function extractSafetyBaseEntries(md: string): Set<string> {
  const entries = new Set<string>();
  let inBaseSection = false;
  for (const line of md.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const h = heading[1].trim().toLowerCase();
      inBaseSection = h === 'allergies' || h === 'medications';
      continue;
    }
    if (inBaseSection) {
      const bullet = line.match(/^-\s+(.+?)(?:\s+—.*)?$/);
      if (bullet) entries.add(bullet[1].trim().toLowerCase());
    }
  }
  return entries;
}

/** The first base allergy/med entity present in `current` but missing from `proposed`, else null. */
function safetyDroppedBaseEntry(current: string, proposed: string): string | null {
  const proposedEntries = extractSafetyBaseEntries(proposed);
  for (const entity of extractSafetyBaseEntries(current)) {
    if (!proposedEntries.has(entity)) return entity;
  }
  return null;
}

async function classifyManagedWrite(
  engine: MemoryEngine,
  rawPath: string,
  mode: string,
  content: string,
): Promise<ToolResult | null> {
  const p = normalizeManagedPath(rawPath);
  const lower = p.toLowerCase();

  // Narrative lane stays writable (append-only, lossless). Checked first so a `memory/…`
  // path never collides with the `MEMORY.md` rule.
  if (lower.startsWith('memory/')) return null;

  if (lower.startsWith('ledger/')) return rejection(MANAGED_REJECT.ledger);
  if (lower === 'memory.md') return rejection(MANAGED_REJECT.memoryMd);
  if (lower.startsWith('episodes/')) return rejection(MANAGED_REJECT.episodes);
  if (lower === 'curiosity.md') return rejection(MANAGED_REJECT.curiosity);
  if (lower.startsWith('.state/')) return rejection(MANAGED_REJECT.state);
  if (lower.startsWith('scratch/')) return rejection(MANAGED_REJECT.scratch);

  if (lower === 'safety.md') {
    // Removal is only possible via overwrite — append cannot drop text (G1).
    if (mode === 'append') return null;
    let current: string | null = null;
    try {
      current = await engine.readFile(p);
    } catch {
      current = null;
    }
    if (current) {
      const dropped = safetyDroppedBaseEntry(current, content);
      if (dropped) return rejection(MANAGED_REJECT.safetyDrop(dropped));
    }
    return null; // a non-dropping SAFETY.md overwrite is not destructive
  }

  return null; // unmanaged path (core files, conditions/*, …) — allowed as before
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- profileId reserved for Task 8 (profile-scoped index metadata)
export function createMemoryTools(engine: MemoryEngine, search?: MemorySearch, indexer?: MemoryIndexer, _profileId?: string): Tool[] {
  const memoryGet: Tool = {
    name: 'memory_get',
    group: 'group:memory',
    description: 'Read the contents of a health memory file by path (e.g., "SOUL.md", "conditions/diabetes.md")',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within workspace' },
      },
      required: ['path'],
    },
    async execute(params): Promise<ToolResult> {
      const filePath = params.path as string;
      let content: string | null;
      try {
        content = await engine.readFile(filePath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith('Path is a directory')) {
          return { content: [{ type: 'text', text: msg }], isError: true };
        }
        throw e;
      }
      if (content === null) {
        return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
      }
      return { content: [{ type: 'text', text: content }] };
    },
  };

  const memoryWrite: Tool = {
    name: 'memory_write',
    group: 'group:memory',
    description: 'Write or append content to a health memory file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within workspace' },
        content: { type: 'string', description: 'Content to write' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode (default: overwrite)' },
      },
      required: ['path', 'content'],
    },
    async execute(params): Promise<ToolResult> {
      const filePath = params.path as string;
      const content = params.content as string;
      const mode = (params.mode as string) ?? 'overwrite';

      // Managed-lane guard (G1): refuse invariant-bearing paths before any write.
      const managed = await classifyManagedWrite(engine, filePath, mode, content);
      if (managed) return managed;

      if (mode === 'append') {
        // SEC-M2b: capture the FULL existing content pre-append — both for the
        // tail-window pre-scan and as the rollback target if the post-append
        // full-file re-scan catches a split-append credential that the
        // tail-window pre-scan missed.
        let preAppendContent: string | null = null;
        try {
          preAppendContent = await engine.readFile(filePath);
        } catch {
          // file doesn't exist yet, that's fine
        }
        const existingTail = preAppendContent !== null && preAppendContent.length > 0
          ? preAppendContent.slice(-8192)
          : '';
        const combined = existingTail + content;
        const rejection = contentContainsCredentials(combined);
        if (rejection.matched) {
          return {
            content: [{ type: 'text', text: `Write rejected: content matches credential pattern (${rejection.pattern}). PHI/sensitive data should not be stored in plain text memory files.` }],
            isError: true,
          };
        }
        await engine.appendToFile(filePath, content);

        // SEC-M2b: re-read the ENTIRE assembled file and re-scan. A split-append
        // can hide a label behind >8192 chars of non-alphanumeric padding so the
        // tail-window pre-scan passes, yet the assembled file reconstructs a
        // complete credential. On match, roll the append back to the pre-append
        // content and reject. Cost is acceptable for health-memory files. A
        // rollback failure must warn-and-continue (resilience) — never crash.
        try {
          const assembled = await engine.readFile(filePath);
          if (assembled !== null) {
            const postRejection = contentContainsCredentials(assembled);
            if (postRejection.matched) {
              try {
                await engine.writeFile(filePath, preAppendContent ?? '');
              } catch (rollbackError) {
                console.warn(
                  '[memory-tools] Credential rejection rollback failed:',
                  summarizeErrorForLog(rollbackError),
                );
              }
              return {
                content: [{ type: 'text', text: `Write rejected: appended content completes a credential pattern (${postRejection.pattern}). PHI/sensitive data should not be stored in plain text memory files.` }],
                isError: true,
              };
            }
          }
        } catch (postScanError) {
          // Post-append re-scan is defense-in-depth; a read failure here must
          // not undo a legitimate append nor crash the daemon.
          console.warn(
            '[memory-tools] Post-append credential re-scan failed (continuing):',
            summarizeErrorForLog(postScanError),
          );
        }
      } else {
        const rejection = contentContainsCredentials(content);
        if (rejection.matched) {
          return {
            content: [{ type: 'text', text: `Write rejected: content matches credential pattern (${rejection.pattern}). PHI/sensitive data should not be stored in plain text memory files.` }],
            isError: true,
          };
        }
        await engine.writeFile(filePath, content);
      }
      if (indexer) {
        void indexer.indexFile(filePath).catch(e =>
          console.warn(`[memory-tools] Reindex failed for ${filePath}:`, summarizeErrorForLog(e)),
        );
      }
      return { content: [{ type: 'text', text: `Written to ${filePath}` }] };
    },
  };

  const memorySearch: Tool = {
    name: 'memory_search',
    group: 'group:memory',
    description: 'Semantic search across health memory files. Optional lane filter narrows to a memory lane.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
        lane: { type: 'string', enum: Object.keys(LANE_PREFIX), description: 'Restrict results to one memory lane (path prefix)' },
        status: { type: 'string', description: 'Fact status filter — accepted but a no-op in P1 (chunk index has no status); reserved for P2' },
      },
      required: ['query'],
    },
    async execute(params): Promise<ToolResult> {
      if (!search) {
        return { content: [{ type: 'text', text: 'Memory search not available' }], isError: true };
      }
      const limit = (params.limit as number) ?? 5;
      const lane = params.lane as string | undefined;
      const prefix = lane ? LANE_PREFIX[lane] : undefined;
      // Over-fetch when filtering so the lane still yields up to `limit` hits, then slice.
      const fetchK = prefix ? Math.max(limit * 4, 20) : limit;
      let results = await search.search(params.query as string, fetchK);
      if (prefix) results = results.filter(r => r.path.startsWith(prefix));
      results = results.slice(0, limit);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No results found' }] };
      }
      const status = results[0].status ?? 'full';
      const qualityBanner = status === 'full' ? '' : `[search-quality: ${status}]\n`;
      const text = qualityBanner + results
        .map(r => `## ${r.path} [${r.chunkId}] lines ${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n${r.content}`)
        .join('\n\n---\n\n');
      return { content: [{ type: 'text', text }] };
    },
  };

  const memoryList: Tool = {
    name: 'memory_list',
    group: 'group:memory',
    description: 'List files and directories in a memory workspace path',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within workspace (default: root)' },
      },
    },
    async execute(params): Promise<ToolResult> {
      const dirPath = (params.path as string) ?? '';
      if (dirPath.includes('..')) {
        return { content: [{ type: 'text', text: 'Path traversal is not allowed.' }], isError: true };
      }
      const files = await engine.listFiles(dirPath);
      if (files.length === 0) {
        return { content: [{ type: 'text', text: 'No files found' }] };
      }
      return { content: [{ type: 'text', text: files.join('\n') }] };
    },
  };

  return [memoryGet, memoryWrite, memorySearch, memoryList];
}
