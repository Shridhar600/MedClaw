export interface BindCheckResult {
  localhostOnly: boolean;
  warnings: string[];
}

export function checkProviderBindAddresses(config: { providers: Record<string, { baseUrl?: string }> }): BindCheckResult {
  const warnings: string[] = [];
  const isLocalhost = (hostname: string): boolean => {
    const h = hostname.replace(/^\[(.+)\]$/, '$1');
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return false;
  };
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.baseUrl) continue;
    try {
      const url = new URL(provider.baseUrl);
      const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
      if (host === '0.0.0.0') {
        warnings.push(`${name} provider (${provider.baseUrl}) binds all interfaces (0.0.0.0) — NOT localhost-only; health data may be exposed to the network`);
      } else if (!isLocalhost(host)) {
        warnings.push(`${name} provider (${provider.baseUrl}) is not localhost — health data may leave the machine`);
      }
    } catch {
      warnings.push(`${name} provider has invalid baseUrl`);
    }
  }
  return { localhostOnly: warnings.length === 0, warnings };
}
