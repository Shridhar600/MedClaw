// Side-file quarantine for corrupt store bytes. SAFETY.md and MEMORY.md are injected verbatim into the
// LLM prompt, so salvaged (possibly attacker-influenced) bytes must never be inlined there. The raw bytes
// go to a 0600 side file; only a constant, date-free, content-free pointer is inlined.

import { createHash } from 'crypto';
import { secureWrite } from './secure-fs';
import { summarizeErrorForLog } from './log';

/** The single line inlined in place of corrupt bytes. Constant → no content, no date. */
export const QUARANTINE_POINTER = '<!-- PARSE-ERROR: prior unreadable content quarantined to a side file -->';

/** Prefix stores match to detect (and preserve) a quarantine pointer line across re-renders. */
export const QUARANTINE_POINTER_PREFIX = '<!-- PARSE-ERROR:';

/**
 * Write `rawBytes` to `<filePath>.quarantine-<contentHash>` at 0600 and return the
 * constant pointer to inline into the rendered file. Warn-and-continue on failure
 * (never throw — the caller is already degrading). The hash suffix (not a timestamp)
 * keeps the sidecar name date-free and dedupes identical corrupt content.
 */
export function quarantineToSideFile(filePath: string, rawBytes: string | Buffer): string {
  try {
    // Keep Buffer input byte-for-byte so invalid UTF-8 never changes while being quarantined.
    const bytes = typeof rawBytes === 'string' ? Buffer.from(rawBytes, 'utf8') : Buffer.from(rawBytes);
    const suffix = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    secureWrite(`${filePath}.quarantine-${suffix}`, bytes);
  } catch (err) {
    console.warn(`[security] quarantine side-file write failed: ${summarizeErrorForLog(err)}`);
  }
  return QUARANTINE_POINTER;
}
