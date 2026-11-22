/** Collapse CR/LF/TAB runs to single spaces, strip leading '#' markers, trim. */
export function sanitizeSingleLine(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[#\s]+/, '')
    .trim();
}

export function normalizeEntitySlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized === '' || hasUnsafeEntityCharacter(normalized)) return null;
  return normalized;
}

function hasUnsafeEntityCharacter(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x23 || codePoint === 0x2028 || codePoint === 0x2029
      || (codePoint >= 0 && codePoint <= 0x1f)
      || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Prefix line-leading H2 markers so captured text remains data, not store structure. */
export function neutralizeStructuralHeadings(text: string): string {
  return text.replace(/(^|[\r\n])([ \t]*)(##)(?= )/g, '$1$2\\$3');
}
