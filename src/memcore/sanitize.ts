// src/memcore/sanitize.ts
//
// Central single-line sanitizer for every Markdown render boundary that embeds
// caller/model-controlled text (INJ / SB-4 class). A value containing newlines
// could otherwise open a new heading/section or forge field lines on re-parse;
// a leading '#' could turn an embedded value into a heading at line start.
// Mirrors the curated-memory/curiosity-queue entry pattern, in ONE place.

/** Collapse CR/LF/TAB runs to single spaces, strip leading '#' markers, trim. */
export function sanitizeSingleLine(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[#\s]+/, '')
    .trim();
}
