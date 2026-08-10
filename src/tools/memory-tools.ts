import type { Tool, ToolResult } from './types';
import type { MemoryEngine } from '../memory/memory-engine';
import type { MemorySearch } from '../memory/search';
import type { MemoryIndexer } from '../memory/indexer';
import { contentContainsCredentials, summarizeErrorForLog } from '../security';

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
    description: 'Semantic search across all health memory files',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
      },
      required: ['query'],
    },
    async execute(params): Promise<ToolResult> {
      if (!search) {
        return { content: [{ type: 'text', text: 'Memory search not available' }], isError: true };
      }
      const results = await search.search(params.query as string, (params.limit as number) ?? 5);
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
