
export function isRemoteEmbeddingBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  const h = host.replace(/^\[|\]$/g, '').toLowerCase(); // strip IPv6 brackets
  return !(h === 'localhost' || h === '127.0.0.1' || h === '::1');
}
