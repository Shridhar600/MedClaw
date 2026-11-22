import type { Tool, ToolResult } from './types';
import type { MemoryEngine } from '../memory/memory-engine';
import type { MemorySearch } from '../memory/search';
import type { MemoryIndexer } from '../memory/indexer';
import type { FactMirror, FactRecord } from '../ports';
import type { QueuePort } from '../capture';
import { chunkHasStaleEntity } from '../recall';
import * as path from 'path';
import { contentContainsCredentials, summarizeErrorForLog, PathContainmentError } from '../security';

const LANE_PREFIX: Record<string, string> = {
  narrative: 'memory/',
  ledger: 'ledger/',
  episode: 'episodes/',
  digest: 'digest/',
  archive: 'archive/',
};

const MANAGED_REJECT = {
  ledger: 'Direct writes to the versioned ledger are not allowed. Use ledger_record / ledger_update — versioning, med-class confirmation, and the SAFETY.md re-render live there.',
  memoryMd: 'Direct writes to MEMORY.md are not allowed — it is managed by the curated-memory budget engine (Health 60 / Life 20 / Agent 20).',
  safetyDrop: (entity: string): string =>
    `Refused: this SAFETY.md overwrite would drop the base allergy/medication entry "${entity}". Removal requires user confirmation — route it through ledger_update.`,
  episodes: 'Direct writes to episodes/ are not allowed. Use episode_manage.',
  curiosity: 'Direct writes to curiosity.md are not allowed (owned by the curiosity queue).',
  state: 'Direct writes to .state/ are not allowed (owned by the scheduler/store internals).',
  scratch: 'Direct writes to scratch/ are not allowed via memory_write.',
  traversal: 'Path traversal is not allowed.',
  soul: 'SOUL.md holds the safety doctrine and cannot be overwritten. Use mode "append" to add a note.',
  dailyLog: 'Captured daily logs are append-only (they hold your exact words and ledger anchors). Use mode "append" to add a note.',
} as const;

/** Tool results reach the ReAct loop verbatim; keep them bounded. */
export const MEMORY_TOOL_MAX_BYTES = 16 * 1024;
export const MEMORY_TOOL_MAX_TOKENS = 4_000;

/** Collapses `.`/`..`; `null` means the path escapes the workspace. */
function normalizeManagedPath(p: string): string | null {
  const s = path.posix.normalize(p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''));
  if (s.split('/').includes('..')) return null;
  return s;
}

function rejection(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function isPathError(error: unknown): boolean {
  if (error instanceof PathContainmentError) return true;
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === 'ERR_PATH_CONTAINMENT') return true;
  const message = error instanceof Error ? error.message : '';
  return message === 'Absolute paths are not allowed' || message.startsWith('Path traversal detected:');
}

function invalidPathResult(): ToolResult {
  return rejection('Invalid path: it must stay inside the memory workspace and must not contain path separators or "..".');
}

function estimateToolTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function safeToolSlice(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  let sliced = value.slice(0, maxChars);
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) sliced = sliced.slice(0, -1);
  return sliced;
}

function truncateToolText(value: string, label: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MEMORY_TOOL_MAX_BYTES && estimateToolTokens(value) <= MEMORY_TOOL_MAX_TOKENS) {
    return value;
  }

  let end = Math.min(value.length, MEMORY_TOOL_MAX_BYTES, MEMORY_TOOL_MAX_TOKENS * 4);
  const markerFor = (omittedBytes: number): string => `\n\n[TRUNCATED ${label}: ${omittedBytes} bytes omitted]`;
  while (end > 0) {
    const prefix = safeToolSlice(value, end);
    const marker = markerFor(Buffer.byteLength(value.slice(prefix.length), 'utf8'));
    const candidate = `${prefix}${marker}`;
    if (Buffer.byteLength(candidate, 'utf8') <= MEMORY_TOOL_MAX_BYTES
      && estimateToolTokens(candidate) <= MEMORY_TOOL_MAX_TOKENS) {
      return candidate;
    }
    end--;
  }
  return safeToolSlice(markerFor(Buffer.byteLength(value, 'utf8')), MEMORY_TOOL_MAX_BYTES);
}

function exceedsMemoryWriteLimit(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') > MEMORY_TOOL_MAX_BYTES
    || estimateToolTokens(value) > MEMORY_TOOL_MAX_TOKENS;
}

/** Best effort: `available:false` means the filter could not be applied, not an empty mirror. */
async function loadEntityHeads(mirror: FactMirror | undefined): Promise<{ heads: FactRecord[]; available: boolean }> {
  if (!mirror) return { heads: [], available: false };
  try {
    const heads: FactRecord[] = [];
    for await (const h of mirror.queryEntityHeads()) heads.push(h);
    return { heads, available: true };
  } catch (e) {
    console.warn('[memory-tools] entity-heads load failed (status filter skipped):', summarizeErrorForLog(e));
    return { heads: [], available: false };
  }
}

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

function safetyDroppedBaseEntry(current: string, proposed: string): string | null {
  const proposedEntries = extractSafetyBaseEntries(proposed);
  for (const entity of extractSafetyBaseEntries(current)) {
    if (!proposedEntries.has(entity)) return entity;
  }
  return null;
}

// memory_write never overwrites a managed path.
async function classifyManagedWrite(
  engine: MemoryEngine,
  rawPath: string,
  mode: string,
  content: string,
): Promise<ToolResult | null> {
  const p = normalizeManagedPath(rawPath);
  if (p === null) return rejection(MANAGED_REJECT.traversal);
  const lower = p.toLowerCase();

  // Checked before MEMORY.md so `memory/...` never collides with it.
  if (lower.startsWith('memory/')) {
    if (mode !== 'append' && /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(lower)) return rejection(MANAGED_REJECT.dailyLog);
    return null;
  }

  if (lower.startsWith('ledger/')) return rejection(MANAGED_REJECT.ledger);
  if (lower === 'memory.md') return rejection(MANAGED_REJECT.memoryMd);
  if (lower.startsWith('episodes/')) return rejection(MANAGED_REJECT.episodes);
  if (lower === 'curiosity.md') return rejection(MANAGED_REJECT.curiosity);
  if (lower.startsWith('.state/')) return rejection(MANAGED_REJECT.state);
  if (lower.startsWith('scratch/')) return rejection(MANAGED_REJECT.scratch);
  if (lower === 'soul.md' && mode !== 'append') return rejection(MANAGED_REJECT.soul);

  if (lower === 'safety.md') {
    // Only an overwrite can drop text; a non-dropping overwrite is allowed.
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
    return null;
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- profileId is reserved for profile-scoped index metadata
export function createMemoryTools(
  engine: MemoryEngine,
  search?: MemorySearch,
  indexer?: MemoryIndexer,
  _profileId?: string,
  // Lazy: the gateway builds the mirror after these tools register; `undefined` means no filtering.
  factMirror?: FactMirror | (() => FactMirror | undefined),
  /** Single-writer coordinator: the whole write runs as one op, so scan-and-rollback is atomic. */
  queue?: QueuePort | (() => QueuePort | undefined),
): Tool[] {
  const getMirror: () => FactMirror | undefined =
    typeof factMirror === 'function' ? factMirror : () => factMirror;
  const getQueue: () => QueuePort | undefined =
    typeof queue === 'function' ? queue : () => queue;
  const memoryGet: Tool = {
    name: 'memory_get',
    group: 'group:memory',
    description: 'Read a bounded portion of a health memory file by path (e.g., "SOUL.md", "conditions/diabetes.md")',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 512, description: 'Relative path within workspace' },
      },
      required: ['path'],
    },
    async execute(params): Promise<ToolResult> {
      const filePath = params.path as string;
      let content: string | null;
      try {
        content = await engine.readFile(filePath);
      } catch (e) {
        if (isPathError(e)) return invalidPathResult();
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith('Path is a directory')) {
          return { content: [{ type: 'text', text: msg }], isError: true };
        }
        throw e;
      }
      if (content === null) {
        return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
      }
      return { content: [{ type: 'text', text: truncateToolText(content, 'memory_get') }] };
    },
  };

  const memoryWrite: Tool = {
    name: 'memory_write',
    group: 'group:memory',
    description: 'Write or append content to a health memory file',
    ownerTurnOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 512, description: 'Relative path within workspace' },
        content: { type: 'string', maxLength: MEMORY_TOOL_MAX_TOKENS * 4, description: 'Content to write' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode (default: overwrite)' },
      },
      required: ['path', 'content'],
    },
    async execute(params): Promise<ToolResult> {
      try {
        const filePath = params.path as string;
        const content = params.content as string;
        const mode = (params.mode as string) ?? 'overwrite';

        if (typeof filePath !== 'string' || typeof content !== 'string') {
          return rejection('Invalid memory_write parameters: path and content must be strings.');
        }
        if (exceedsMemoryWriteLimit(content)) {
          return rejection(`Write rejected: content exceeds the ${MEMORY_TOOL_MAX_BYTES}-byte / ${MEMORY_TOOL_MAX_TOKENS}-token memory tool limit.`);
        }

        // One coordinator op makes the read-modify-write atomic; no embed/LLM work inside the lock.
        const doWrite = async (): Promise<ToolResult> => {
          const managed = await classifyManagedWrite(engine, filePath, mode, content);
          if (managed) return managed;

          if (mode === 'append') {
            // Keep the pre-append content as the rollback target.
            let preAppendContent: string | null = null;
            try {
              preAppendContent = await engine.readFile(filePath);
            } catch {
              // Treat any read failure as no existing content.
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

            // A split append can hide a credential past the 8192-char tail window; re-scan and roll back.
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
              // A read failure here must not undo a legitimate append.
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
          return { content: [{ type: 'text', text: `Written to ${filePath}` }] };
        };

        // Serialize against every other memory-domain writer; without a coordinator, run inline.
        const coordinator = getQueue();
        const result = coordinator
          ? await coordinator.enqueue('turn', { label: 'memory:write', scope: 'memory', run: doWrite })
          : await doWrite();
        // Indexing stays off the lock and only runs on success.
        if (indexer && !result.isError) {
          void indexer.indexFile(filePath).catch(e =>
            console.warn(`[memory-tools] Reindex failed for ${filePath}:`, summarizeErrorForLog(e)),
          );
        }
        return result;
      } catch (e) {
        if (isPathError(e)) return invalidPathResult();
        throw e;
      }
    },
  };

  const memorySearch: Tool = {
    name: 'memory_search',
    group: 'group:memory',
    description: 'Semantic search across health memory files. Optional lane filter narrows to a memory lane.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 2_000, description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
        lane: { type: 'string', enum: Object.keys(LANE_PREFIX), description: 'Restrict results to one memory lane (path prefix)' },
        status: { type: 'string', enum: ['active', 'all'], description: 'Fact-status filter: "active" (default) drops results whose ledger entity is stale (retracted/discontinued/superseded); "all" returns every version.' },
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
      // Same stale-drop rule as recall so both paths agree; version ordering is ledger_query's job.
      const factStatus = (params.status as string) ?? 'active';
      const willStatusFilter = factStatus !== 'all';
      // Over-fetch because a lane or status filter can drop rows.
      const fetchK = (prefix || willStatusFilter) ? Math.max(limit * 4, 20) : limit;
      let results = await search.search(params.query as string, fetchK);
      if (prefix) results = results.filter(r => r.path.startsWith(prefix));
      // Fail open but tell the model: never let it assume active-only filtering happened.
      let statusUnavailable = false;
      if (willStatusFilter) {
        const { heads, available } = await loadEntityHeads(getMirror());
        statusUnavailable = !available;
        if (heads.length > 0) {
          results = results.filter(r => !chunkHasStaleEntity(r.content, heads));
        }
      }
      results = results.slice(0, limit);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No results found' }] };
      }
      const quality = results[0].status ?? 'full';
      const qualityBanner = quality === 'full' ? '' : `[search-quality: ${quality}]\n`;
      const statusBanner = statusUnavailable ? '[fact-status: unavailable — results NOT filtered by ledger status]\n' : '';
      const text = statusBanner + qualityBanner + results
        .map(r => `## ${r.path} [${r.chunkId}] lines ${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n${r.content}`)
        .join('\n\n---\n\n');
      return { content: [{ type: 'text', text: truncateToolText(text, 'memory_search') }] };
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
      return { content: [{ type: 'text', text: truncateToolText(files.join('\n'), 'memory_list') }] };
    },
  };

  return [memoryGet, memoryWrite, memorySearch, memoryList];
}
