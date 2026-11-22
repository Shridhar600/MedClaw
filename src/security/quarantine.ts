
import { createHash } from 'crypto';
import { secureWrite } from './secure-fs';
import { summarizeErrorForLog } from './log';

/** The single line inlined in place of corrupt bytes. Constant → no content, no date. */
export const QUARANTINE_POINTER = '<!-- PARSE-ERROR: prior unreadable content quarantined to a side file -->';

/** Prefix stores match to detect (and preserve) a quarantine pointer line across re-renders. */
export const QUARANTINE_POINTER_PREFIX = '<!-- PARSE-ERROR:';

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
