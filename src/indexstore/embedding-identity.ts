// src/indexstore/embedding-identity.ts
//
// Embedding provider locality check (P2 A3.1b / v2-BL-2 = specs/13 B1). The recall latency budget
// (p50≤300ms / p95≤800ms) assumes LOCAL embeddings; a remote embeddings endpoint blows past it, so
// the gateway logs a boot config warning. Pure — no I/O.

/**
 * True when the embeddings base URL points at a non-loopback host (public or LAN). A missing,
 * empty, or unparseable URL is treated as LOCAL (the default Ollama assumption) — never warn on
 * ambiguity, only on a clearly-remote host.
 */
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
