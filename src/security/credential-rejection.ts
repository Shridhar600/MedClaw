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

function stripDefaultIgnorableCodePoints(content: string): string {
  return content.replace(/\p{Default_Ignorable_Code_Point}/gu, '');
}

const CREDENTIAL_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*['"]?[^A-Za-z0-9_-]{0,100000}[A-Za-z0-9_-]{16,}/i,
  /(?:-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----)/i,
  /(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{36,}/,
  /(?:sk-[A-Za-z0-9]{32,})/,
  /(?:xox[abp]-[A-Za-z0-9-]+)/,
];

export function contentContainsCredentials(content: string): { matched: boolean; pattern: string } {
  const normalized = normalizeHomoglyphs(stripDefaultIgnorableCodePoints(content)).toLowerCase();
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return { matched: true, pattern: pattern.source.slice(0, 40) };
    }
  }
  return { matched: false, pattern: '' };
}
