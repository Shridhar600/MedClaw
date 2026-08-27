// src/tools/session-tools.ts
//
// session_search (PLAT-20, spec 14 §2) — verbatim FTS over the append-only day-file session archive.
// This is how the agent recalls something said many turns ago (including a tool result that prune
// replaced with a marker in the rolling window — the losslessness contract). Read-only; it never
// mutates the archive.
//
// The result's session identity is the day-file `{file, line}` anchor, rendered `sessions/<file>#L<line>`
// (A-L1: the anchor IS the session ID PLAT-20 asks for). Degrades gracefully — a failed index yields a
// plain "unavailable" note, never a throw (resilience). PHI: snippets are returned to the agent (that is
// the feature — verbatim retrieval into the agent's own 0600 context) but are NEVER logged.

import type { Tool, ToolResult } from './types';
import type { SessionSearchResult } from '../indexstore';
import { summarizeErrorForLog } from '../security';

export interface SessionSearchIndex {
  search(query: string, opts?: { limit?: number }): SessionSearchResult;
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
    async execute(params): Promise<ToolResult> {
      const query = typeof params.query === 'string' ? params.query : '';
      if (query.trim().length === 0) {
        return ok('Provide a non-empty query to search past conversation turns.');
      }
      const limit = typeof params.limit === 'number' ? params.limit : undefined;

      try {
        const result = deps.index.search(query, limit !== undefined ? { limit } : undefined);
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
        // The index degrades internally, but never let the tool throw (resilience). Sanitized frame only.
        console.warn('[session_search] failed:', summarizeErrorForLog(e));
        return ok('Session search is temporarily unavailable (index error). Try again shortly.');
      }
    },
  };

  return [sessionSearch];
}
