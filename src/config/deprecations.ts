// src/config/deprecations.ts
//
// P2b spec 14 §6 / DD10 — the idle-reset config keys are retired. They are still READ for one release
// (so an old config still loads) but trigger nothing; boot warns once when a user set them to a
// non-default value (A-L5: the keys are required-with-defaults, so a differs-from-default check avoids
// warning users who never touched them). `sessions.compaction.keepRecentTurns` is migrated to
// `sessions.window.keepRecentTurns`; using the old one without the new one warns too.

import type { SessionsConfig } from './types';
import { DEFAULT_CONFIG } from './defaults';

/** Deprecation warnings for a resolved SessionsConfig (empty when nothing deprecated is in effect). */
export function deprecatedSessionWarnings(sessions: SessionsConfig): string[] {
  const warnings: string[] = [];
  // M9: total for an absent block — a partial config (or a Gateway built without loadConfig) must not
  // crash boot on a deprecation check.
  if (!sessions) return warnings;
  if (sessions.softResetAfterMinutes !== DEFAULT_CONFIG.sessions.softResetAfterMinutes) {
    warnings.push(
      'sessions.softResetAfterMinutes is deprecated (P2b spec 14 §6) — idle resets are retired; the value is ignored. Remove it from config.json.',
    );
  }
  if (sessions.hardResetAfterMinutes !== DEFAULT_CONFIG.sessions.hardResetAfterMinutes) {
    warnings.push(
      'sessions.hardResetAfterMinutes is deprecated (P2b spec 14 §6) — idle resets are retired; the value is ignored. Remove it from config.json.',
    );
  }
  // The compaction keepRecentTurns knob moved under sessions.window; warn if only the old one is set.
  if (sessions.window === undefined && sessions.compaction?.keepRecentTurns !== undefined) {
    warnings.push(
      'sessions.compaction.keepRecentTurns is deprecated (P2b spec 14 §3) — set sessions.window.keepRecentTurns instead.',
    );
  }
  return warnings;
}
