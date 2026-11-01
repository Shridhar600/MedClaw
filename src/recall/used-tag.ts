
export interface UsedTag {
  ids: string[];
  stripped: string;
}

const USED_TAG_RE = /<used>([^<>\n]*)<\/used>/g;

export function parseUsedTag(text: string): UsedTag {
  const ids: string[] = [];
  const seen = new Set<string>();
  let found = false;
  const stripped = text.replace(USED_TAG_RE, (_match, inner: string) => {
    found = true;
    for (const id of inner.split(',').map(s => s.trim()).filter(Boolean)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return '';
  });
  if (!found) return { ids: [], stripped: text }; // garbled/unclosed/no-tag ⇒ no signal, text intact
  return { ids, stripped: stripped.replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '') };
}
