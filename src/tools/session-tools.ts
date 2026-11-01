
import type { Tool, ToolResult } from './types';
import type { SessionSearchResult } from '../indexstore';
import { summarizeErrorForLog } from '../security';

export interface SessionSearchIndex {
  search(query: string, opts?: { chatId?: string; limit?: number }): SessionSearchResult;
}

export interface SessionToolsDeps {
  index: SessionSearchIndex;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function createSessionTools(deps: SessionToolsDeps): Tool[] {
  const sessionSearch: Tool = {
    name: 'session_search',
    group: 'group:session',
    description:
      'Search the full verbatim conversation history (every past turn, across all days) for exact words ' +
      'or clinical phrases — e.g. a drug name, dose, or symptom mentioned earlier. Use it to recall ' +
      'something said many turns ago that is no longer in the visible context. Returns the matching ' +
      'turns verbatim with a sessions/<file>#L<line> anchor, role, and timestamp.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Exact words or a clinical phrase to find in past turns.' },
        limit: { type: 'number', description: 'Maximum turns to return (default 20).' },
      },
      required: ['query'],
    },
    async execute(params, context): Promise<ToolResult> {
      const query = typeof params.query === 'string' ? params.query : '';
      if (query.trim().length === 0) {
        return ok('Provide a non-empty query to search past conversation turns.');
      }
      const limit = typeof params.limit === 'number' ? params.limit : undefined;
      const chatId = context?.chatId;
      if (chatId === undefined) {
        return ok('Session search is unavailable in this context.');
      }

      try {
        const result = deps.index.search(query, { chatId, ...(limit !== undefined ? { limit } : {}) });
        if (result.status === 'failed') {
          return ok('Session search is temporarily unavailable (index error). Try again shortly.');
        }
        if (result.hits.length === 0) {
          return ok(`No past conversation turns matched "${query}".`);
        }
        const lines = result.hits.map(
          (h) => `sessions/${h.file}#L${h.line} [${h.role} · ${h.ts}]\n${h.snippet}`,
        );
        const header = `Found ${result.hits.length} matching turn(s) for "${query}":`;
        return ok([header, ...lines].join('\n\n'));
      } catch (e) {
        // Never let the tool throw. Sanitized frame only.
        console.warn('[session_search] failed:', summarizeErrorForLog(e));
        return ok('Session search is temporarily unavailable (index error). Try again shortly.');
      }
    },
  };

  return [sessionSearch];
}
