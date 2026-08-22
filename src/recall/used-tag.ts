// src/recall/used-tag.ts
//
// The B7 usage-feedback tag (specs/13 B7, v2-H-3). The model may end a reply with a single
// trailing line `<used>id1,id2</used>` naming the recall chunk ids it actually used. The AgentLoop
// parses + STRIPS it before disclaimer-append / persist / send, then feeds the ids to Stage-4
// chunk_stats (bumpUsed). Missing or garbled ⇒ no signal that turn, never an error. Pure.

export interface UsedTag {
  ids: string[];
  stripped: string;
}

const USED_TAG_RE = /\n?<used>([^<>\n]*)<\/used>\s*$/;

export function parseUsedTag(text: string): UsedTag {
  const m = text.match(USED_TAG_RE);
  if (!m || m.index === undefined) return { ids: [], stripped: text };
  const ids = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const stripped = text.slice(0, m.index).replace(/\s+$/, '');
  return { ids, stripped };
}
