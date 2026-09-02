// src/memcore/transcript-sweep.ts
//
// Deterministic nightly transcript sweep (spec 14 §5, PD-17 dreaming step 1.5 — NO LLM).
// Diff yesterday's session JSONL against yesterday's ledger writes: any entity-ish mention in a
// user chat turn that had no same-day ledger event AND no existing curiosity item becomes a
// `missing-data` curiosity question ("Did I miss logging X yesterday?"). Capture misses become
// questions, not silent loss.
//
// PURE: no I/O, no clock, no randomness — fully unit-testable. The scheduler job (D4.4) supplies the
// day-file lines, yesterday's ledger entities, and the current unresolved curiosity items, then
// persists the bounded result.

import type { AddCuriosityInput } from './curiosity-queue';
import type { CuriosityItem } from './types';

export interface SweepLexicon {
  /** Medication / drug names — a hit is `critical`. */
  med: string[];
  /** Symptom words — a hit is a non-critical miss. */
  symptom: string[];
  /** Appointment / visit words — a hit is a non-critical miss. */
  appointment: string[];
}

export interface SweepInput {
  /** Raw JSONL lines from yesterday's day file(s) (one serialized `JsonlEntry` per line). */
  dayFileLines: string[];
  /** NORMALIZED entity names that had a ledger write yesterday (see `normalizeEntity`). */
  ledgerEntitiesForDay: Set<string>;
  /** Current UNRESOLVED curiosity items — used to dedup a recurring miss across nights (DD7). */
  existingCuriosity: CuriosityItem[];
  /** Keyword lexicon; defaults to `DEFAULT_SWEEP_LEXICON` when omitted. */
  lexicon?: SweepLexicon;
  /** Bound on items filed per night (spec 14 §5: ≤5). */
  maxItems?: number;
}

export interface SweepResult {
  items: AddCuriosityInput[];
}

// A common, deliberately small default lexicon. The real deployment can pass a richer one; the
// sweep never depends on a specific term being present (a miss it can't classify is simply not filed).
export const DEFAULT_SWEEP_LEXICON: SweepLexicon = {
  med: [
    'ibuprofen', 'naproxen', 'acetaminophen', 'paracetamol', 'aspirin', 'metformin', 'insulin',
    'lisinopril', 'atorvastatin', 'amlodipine', 'omeprazole', 'levothyroxine', 'amoxicillin',
    'prednisone', 'albuterol', 'gabapentin', 'sertraline', 'losartan', 'hydrochlorothiazide',
  ],
  symptom: [
    'headache', 'migraine', 'nausea', 'dizziness', 'fatigue', 'cough', 'fever', 'rash', 'cramp',
    'insomnia', 'palpitations', 'swelling', 'shortness of breath', 'sore throat',
  ],
  appointment: ['appointment', 'checkup', 'follow-up', 'consultation', 'visit', 'scan', 'x-ray'],
};

const DEFAULT_MAX_ITEMS = 5;

// A dose "number+unit" pattern. Longer units are listed first so alternation prefers them; the
// dose entity strips inner whitespace ("500 mg" -> "500mg") so both spellings collapse to one.
const DOSE_RE = /\b(\d+(?:\.\d+)?)\s?(mcg|mg|ml|iu|units?|tablets?|pills?|puffs?|g)\b/gi;

/** Lowercase + trim + collapse internal whitespace. Applied to BOTH mentions and ledger entities. */
export function normalizeEntity(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

type Category = 'med' | 'symptom' | 'appointment' | 'med-dose';

interface Mention {
  /** Surface form (original casing) of the first occurrence — used in the question text. */
  surface: string;
  /** Normalized entity — the dedup key and `relatedEntity`. */
  entity: string;
  category: Category;
  /** Transcript turn index (mining order). */
  turn: number;
  /** Character offset within the turn (MEDIUM-4: a composite (turn, pos) key — no fixed stride that a
   *  >1,000,000-char turn could overflow). */
  pos: number;
}

// Only a medication-lexicon hit is critical. A bare dose ("500 mg") with no medication context is a
// real capture miss but NON-critical (spec 14 §5: "non-critical unless med lexicon") — MEDIUM-3.
function isCritical(category: Category): boolean {
  return category === 'med';
}

// Order mentions by transcript position: earlier turn first, then earlier char offset.
function byTranscript(a: Mention, b: Mention): number {
  return a.turn - b.turn || a.pos - b.pos;
}

function escapeRe(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Extract keyword + dose mentions from one user-turn's content, in text order. A dose is only
// mined when the turn has NO med keyword (otherwise it is reinforcement of that med, not a new miss).
function extractTurnMentions(content: string, lexicon: SweepLexicon, turn: number): Mention[] {
  const found: Mention[] = [];
  const categories: Array<[Category, string[]]> = [
    ['med', lexicon.med],
    ['symptom', lexicon.symptom],
    ['appointment', lexicon.appointment],
  ];
  for (const [category, terms] of categories) {
    for (const term of terms) {
      const re = new RegExp(`\\b${escapeRe(term)}\\b`, 'gi');
      for (const m of content.matchAll(re)) {
        found.push({ surface: m[0], entity: normalizeEntity(term), category, turn, pos: m.index ?? 0 });
      }
    }
  }
  const hasMed = found.some(f => f.category === 'med');
  if (!hasMed) {
    for (const m of content.matchAll(DOSE_RE)) {
      const pos = m.index ?? 0;
      // MEDIUM-3: a dose immediately followed by `/` is a concentration/rate (mg/dL, mg/kg), not a
      // plain dose — skip it rather than truncate it into a junk entity.
      if (content[pos + m[0].length] === '/') continue;
      const dose = normalizeEntity(`${m[1]}${m[2]}`).replace(/\s+/g, '');
      found.push({ surface: m[0], entity: dose, category: 'med-dose', turn, pos });
    }
  }
  return found;
}

// A user turn qualifies for mining only when it is a real chat turn (A-H1): role 'user', origin
// 'chat' (default when the field is absent — legacy/migrated turns stay sweepable), and NOT a
// daemon heartbeat prompt (its first physical line is the literal `[Heartbeat Trigger]` marker).
function userChatContent(line: string): string | null {
  let entry: { role?: unknown; content?: unknown; origin?: unknown };
  try {
    entry = JSON.parse(line);
  } catch {
    return null; // malformed line — skip, never throw (resilience)
  }
  if (entry.role !== 'user') return null;
  // MEDIUM-2: trust an EXPLICIT persisted origin. Only fall back to the `[Heartbeat Trigger]` marker
  // heuristic for legacy entries that carry no origin — so a genuine chat turn whose text happens to
  // start with that marker is mined, not silently suppressed.
  const hasOrigin = typeof entry.origin === 'string';
  const origin = hasOrigin ? (entry.origin as string) : 'chat';
  if (origin !== 'chat') return null;
  if (typeof entry.content !== 'string' || entry.content.length === 0) return null;
  if (!hasOrigin && entry.content.split('\n', 1)[0].trim() === '[Heartbeat Trigger]') return null;
  return entry.content;
}

export function sweep(input: SweepInput): SweepResult {
  const lexicon = input.lexicon ?? DEFAULT_SWEEP_LEXICON;
  const requestedMaxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxItems = Number.isFinite(requestedMaxItems)
    ? Math.max(0, Math.min(DEFAULT_MAX_ITEMS, Math.floor(requestedMaxItems)))
    : DEFAULT_MAX_ITEMS;

  // Entities the agent already logged yesterday, and entities we already asked about.
  const loggedSet = new Set<string>();
  for (const e of input.ledgerEntitiesForDay) loggedSet.add(normalizeEntity(e));
  const askedSet = new Set<string>();
  for (const c of input.existingCuriosity) {
    if (c.kind !== 'missing-data') continue;
    askedSet.add(normalizeEntity(c.relatedEntity ?? c.description));
  }

  // Gather mentions across all mined user turns in transcript order.
  const mentions: Mention[] = [];
  let turnIndex = 0;
  for (const line of input.dayFileLines) {
    const content = userChatContent(line);
    if (content === null) continue;
    mentions.push(...extractTurnMentions(content, lexicon, turnIndex));
    turnIndex++;
  }
  mentions.sort(byTranscript);

  // First occurrence per normalized entity wins (its surface + category).
  const firstByEntity = new Map<string, Mention>();
  for (const m of mentions) {
    if (!firstByEntity.has(m.entity)) firstByEntity.set(m.entity, m);
  }

  // Drop entities logged yesterday or already asked about; keep transcript order.
  const candidates: Mention[] = [];
  for (const m of firstByEntity.values()) {
    if (loggedSet.has(m.entity)) continue;
    if (askedSet.has(m.entity)) continue;
    candidates.push(m);
  }

  // A-L3 selection order: med-critical first, then transcript order (stable within each group).
  candidates.sort((a, b) => {
    const ca = isCritical(a.category) ? 0 : 1;
    const cb = isCritical(b.category) ? 0 : 1;
    return ca !== cb ? ca - cb : byTranscript(a, b);
  });

  const items: AddCuriosityInput[] = candidates.slice(0, maxItems).map(m => {
    const item: AddCuriosityInput = {
      kind: 'missing-data',
      description: `Did I miss logging ${m.surface} yesterday?`,
      relatedEntity: m.entity,
    };
    if (isCritical(m.category)) item.critical = true;
    return item;
  });

  return { items };
}
