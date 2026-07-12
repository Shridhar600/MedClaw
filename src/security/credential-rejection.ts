const CREDENTIAL_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/i,
  /(?:-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----)/,
  /(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{36,}/,
  /(?:sk-[A-Za-z0-9]{32,})/,
  /(?:xox[abp]-[A-Za-z0-9-]+)/,
];

export function contentContainsCredentials(content: string): { matched: boolean; pattern: string } {
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) {
      return { matched: true, pattern: pattern.source.slice(0, 40) };
    }
  }
  return { matched: false, pattern: '' };
}
