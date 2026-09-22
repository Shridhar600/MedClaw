/**
 * Shared test fixtures for the memcore/profiles Wave A/B suites.
 *
 * Deterministic clocks + id generators + a LedgerFact builder so store, view,
 * and pipeline tests never depend on wall-clock time or random ids (jest trap:
 * fake timers need setSystemTime; these fixtures sidestep that for pure stores).
 */
import type { Clock, IdGen } from '../../src/ports';
import type { FactType, LedgerFact } from '../../src/memcore';

/** A Clock frozen at a fixed ISO instant. */
export function fixedClock(iso: string): Clock {
  const frozen = new Date(iso);
  return { now: () => new Date(frozen.getTime()) };
}

/** A Clock whose instant can be advanced — for TTL / sweep tests (ScratchStore). */
export interface MutableClock extends Clock {
  advance(ms: number): void;
  set(iso: string): void;
}

export function mutableClock(iso: string): MutableClock {
  let current = new Date(iso).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => { current += ms; },
    set: (next: string) => { current = new Date(next).getTime(); },
  };
}

/** Move a MutableClock forward. Kept as a free function for call-site readability. */
export function advanceClock(clock: MutableClock, ms: number): void {
  clock.advance(ms);
}

/** Deterministic, monotonic IdGen: `${prefix}-1`, `${prefix}-2`, … */
export function seqIdGen(prefix: string): IdGen {
  let n = 0;
  return { newId: () => `${prefix}-${++n}` };
}

/** Resolves after `ms`. Exercises real async ordering (WriteQueue serialization tests). */
export const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_CREATED_AT = '2026-08-18T00:00:00.000Z';

/**
 * Build a fully-formed LedgerFact for store/view/pipeline tests.
 * Overrides win over defaults (spread last), so callers set only what a case needs.
 */
export function fact(entity: string, type: FactType, o: Partial<LedgerFact> = {}): LedgerFact {
  const version = o.version ?? 1;
  const createdAt = o.createdAt ?? DEFAULT_CREATED_AT;
  return {
    id: `${entity}@v${version}`,
    profileId: 'test-profile',
    entity,
    type,
    version,
    status: 'active',
    fields: {},
    provenance: {
      source: 'user',
      confidence: 1,
      anchor: 'memory/seed.md#L1',
      capturedAt: createdAt,
    },
    safetyRelevant: false,
    language: 'en',
    visibility: 'private',
    createdAt,
    ...o,
  };
}
