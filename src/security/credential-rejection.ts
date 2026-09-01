// SEC-M2a: Unicode homoglyph normalization. A credential label written with
// Cyrillic/Greek lookalikes (e.g. Cyrillic а in 'аpi_key') is visually
// identical to the ASCII form but evades an ASCII-only label regex. Map the
// common lookalikes to their ASCII equivalents before scanning — small
// explicit map, no new dependency (per the W3F-B brief).
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic smalls
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ѕ: 's',
  // Cyrillic capitals
  А: 'A', Е: 'E', О: 'O', Р: 'P', С: 'C', Х: 'X', У: 'Y', І: 'I', Ѕ: 'S',
  // Greek common lookalikes
  α: 'a', ο: 'o', ρ: 'p', ε: 'e', ι: 'i', κ: 'k',
};

const HOMOGLYPH_PATTERN = /[аеорсхіѕуАЕОРСХІЅУαορεικ]/g;

function normalizeHomoglyphs(content: string): string {
  return content.replace(HOMOGLYPH_PATTERN, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
}

// Scan-only normalization: Unicode's Default_Ignorable_Code_Point property includes zero-width
// controls, word joiners, soft hyphen, and variation selectors. Removing them from the detector's
// copy closes de-contiguation bypasses without changing the content that is ultimately stored.
function stripDefaultIgnorableCodePoints(content: string): string {
  return content.replace(/\p{Default_Ignorable_Code_Point}/gu, '');
}

const CREDENTIAL_PATTERNS: RegExp[] = [
  // Label + value. The filler `[^A-Za-z0-9_-]{0,100000}` lets the scanner
  // catch a label and value separated by non-alphanumeric padding (the
  // SEC-M2b split-append exploit: label, >8192 '#' chars, then the value).
  // Bounded (not unbounded) so a benign label far away from a long token in a
  // large health note is less likely to false-positive; 100000 comfortably
  // spans the review's >8K exploit padding.
  /(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*['"]?[^A-Za-z0-9_-]{0,100000}[A-Za-z0-9_-]{16,}/i,
  /(?:-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----)/i,
  /(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{36,}/,
  /(?:sk-[A-Za-z0-9]{32,})/,
  /(?:xox[abp]-[A-Za-z0-9-]+)/,
];

export function contentContainsCredentials(content: string): { matched: boolean; pattern: string } {
  // SEC-M2a/M2c: remove default-ignorable code points and normalize homoglyphs to ASCII, then
  // lowercase so invisible splits and case-variant labels (ApiKey, API_KEY) collapse before patterns run.
  const normalized = normalizeHomoglyphs(stripDefaultIgnorableCodePoints(content)).toLowerCase();
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return { matched: true, pattern: pattern.source.slice(0, 40) };
    }
  }
  return { matched: false, pattern: '' };
}
