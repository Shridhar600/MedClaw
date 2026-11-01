
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
  /** Normalized entity names that had a ledger write yesterday (see `normalizeEntity`). */
  ledgerEntitiesForDay: Set<string>;
  /** Current unresolved curiosity items, used to dedup a recurring miss across nights. */
  existingCuriosity: CuriosityItem[];
  /** Keyword lexicon; defaults to `DEFAULT_SWEEP_LEXICON` when omitted. */
  lexicon?: SweepLexicon;
  /** Bound on items filed per night. */
  maxItems?: number;
}

export interface SweepResult {
  items: AddCuriosityInput[];
}

// A deliberately small default lexicon. A miss the sweep cannot classify is simply not filed.
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

const DOSE_RE = /\b(\d+(?:\.\d+)?)\s?(mcg|mg|ml|iu|units?|tablets?|pills?|puffs?|g)\b/gi;

/** Lowercase, trim and collapse internal whitespace. Applied to both mentions and ledger entities. */
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
  /** Character offset within the turn. */
  pos: number;
}

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
      // A dose followed by `/` is a concentration/rate (mg/dL, mg/kg), not a plain dose.
      if (content[pos + m[0].length] === '/') continue;
      const dose = normalizeEntity(`${m[1]}${m[2]}`).replace(/\s+/g, '');
      found.push({ surface: m[0], entity: dose, category: 'med-dose', turn, pos });
    }
  }
  return found;
}

function userChatContent(line: string): string | null {
  let entry: { role?: unknown; content?: unknown; origin?: unknown };
  try {
    entry = JSON.parse(line);
  } catch {
    return null; // malformed line — skip, never throw (resilience)
  }
  if (entry.role !== 'user') return null;
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

  // Selection order: med-critical first, then transcript order (stable within each group).
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
