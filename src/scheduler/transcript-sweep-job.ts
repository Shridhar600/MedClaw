// src/scheduler/transcript-sweep-job.ts
//
// D4.4 — the nightly transcript-sweep runner. Deterministic, NO LLM. Reads yesterday's session
// day-file lines + yesterday's ledger entities via injected seams, runs the pure `sweep`
// (src/memcore), and persists the bounded result to the curiosity queue. Best-effort throughout:
// any I/O failure logs sanitized and continues — a sweep must never crash the daemon (resilience).
//
// The collaborators are injected as small function ports so this runner stays decoupled from the
// SessionManager / FactMirror / CuriosityQueue internals (the Gateway composes the real accessors).

import { sweep } from '../memcore';
import type { AddCuriosityInput, CuriosityItem, SweepLexicon } from '../memcore';
import { summarizeErrorForLog } from '../security';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface NightlySweepDeps {
  /** Raw JSONL lines of `date`'s day file(s), across the profile's chats. */
  readDayLines: (date: Date) => Promise<string[]> | string[];
  /** Normalized entity names that had a ledger write on `date`. */
  ledgerEntitiesForDay: (date: Date) => Promise<Set<string>> | Set<string>;
  /** Current UNRESOLVED curiosity items (for cross-night dedup). */
  listCuriosity: () => Promise<CuriosityItem[]> | CuriosityItem[];
  /** Persist one curiosity item. */
  addCuriosity: (item: AddCuriosityInput) => Promise<unknown>;
  /** Keyword lexicon; the pure sweep defaults it when omitted. */
  lexicon?: SweepLexicon;
  /** Per-night cap (pure sweep defaults to 5). */
  maxItems?: number;
  /** Clock injection for computing "yesterday" (default: real now). */
  now?: () => Date;
}

export interface NightlySweepResult {
  /** false when the scan itself could not run (a read seam threw). */
  scanned: boolean;
  /** How many curiosity items were persisted. */
  added: number;
}

export async function runNightlySweep(deps: NightlySweepDeps): Promise<NightlySweepResult> {
  try {
    const now = deps.now ? deps.now() : new Date();
    // now − 24h always lands on the previous UTC calendar day (UTC has no DST); the injected
    // accessors derive the day-file key from it (shared UTC dateKey, A-H3).
    const yesterday = new Date(now.getTime() - DAY_MS);

    const [dayFileLines, ledgerEntitiesForDay, existingCuriosity] = await Promise.all([
      deps.readDayLines(yesterday),
      deps.ledgerEntitiesForDay(yesterday),
      deps.listCuriosity(),
    ]);

    const { items } = sweep({
      dayFileLines,
      ledgerEntitiesForDay,
      existingCuriosity,
      lexicon: deps.lexicon,
      maxItems: deps.maxItems,
    });

    let added = 0;
    for (const item of items) {
      try {
        await deps.addCuriosity(item);
        added++;
      } catch (e) {
        // One item's write failure must not drop its siblings.
        console.warn(`[sweep] curiosity add failed, continuing: ${summarizeErrorForLog(e)}`);
      }
    }
    return { scanned: true, added };
  } catch (e) {
    console.warn(`[sweep] nightly transcript sweep failed: ${summarizeErrorForLog(e)}`);
    return { scanned: false, added: 0 };
  }
}
