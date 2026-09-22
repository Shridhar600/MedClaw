import { InvariantViolationError } from '../shared/errors';

/**
 * Boot-time safety invariant (D9 / PLAT-04 / PLAT-05).
 *
 * The assembled system prompt MUST contain a non-empty SAFETY.md verbatim and in full —
 * never truncated, never partially injected. This is a pure guard: no I/O, no clock.
 *
 * - Empty / whitespace-only / null / undefined safety content -> no-op (PLAT-04: empty SAFETY.md
 *   is allowed and skipped).
 * - Non-empty content that is not a substring of the prompt -> throw (PLAT-05: partial or missing
 *   injection is a hard failure; the caller aborts the turn/boot). medical-safety > resilience.
 */
export function assertSafetyInjected(
  assembledPrompt: string,
  safetyContent: string | null | undefined,
): void {
  if (safetyContent == null || safetyContent.trim() === '') return;
  if (!assembledPrompt.includes(safetyContent)) {
    throw new InvariantViolationError(
      'SAFETY.md was not injected in full into the assembled prompt (non-omission invariant violated)',
    );
  }
}
