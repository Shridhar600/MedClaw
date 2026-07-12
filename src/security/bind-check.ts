export interface BindCheckResult {
  localhostOnly: boolean;
  warnings: string[];
}

export function checkProviderBindAddresses(config: { providers: Record<string, { baseUrl?: string }> }): BindCheckResult {
  const warnings: string[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.baseUrl) continue;
    try {
      const url = new URL(provider.baseUrl);
      if (!['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname)) {
        warnings.push(`${name} provider (${provider.baseUrl}) is not localhost — health data may leave the machine`);
      }
    } catch {
      warnings.push(`${name} provider has invalid baseUrl`);
    }
  }
  return { localhostOnly: warnings.length === 0, warnings };
}
