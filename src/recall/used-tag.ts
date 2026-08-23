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

// Match EVERY well-formed <used>…</used> occurrence, not just the trailing one (F14): if the model
// emits the tag inline or more than once, none of it may reach the user or the session trace.
const USED_TAG_RE = /<used>([^<>\n]*)<\/used>/g;

export function parseUsedTag(text: string): UsedTag {
  const ids: string[] = [];
  let found = false;
  const stripped = text.replace(USED_TAG_RE, (_match, inner: string) => {
    found = true;
    for (const id of inner.split(',').map(s => s.trim()).filter(Boolean)) ids.push(id);
    return '';
  });
  if (!found) return { ids: [], stripped: text }; // garbled/unclosed/no-tag ⇒ no signal, text intact
  return { ids, stripped: stripped.replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '') };
}
