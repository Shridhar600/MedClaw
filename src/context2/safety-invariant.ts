import { InvariantViolationError } from '../shared/errors';

/**
 * Boot-time safety invariant.
 *
 * The assembled system prompt must contain a non-empty SAFETY.md verbatim and in full: never
 * truncated, never partially injected. This is a pure guard: no I/O, no clock.
 *
 * - Empty, whitespace-only, null or undefined safety content is a no-op (an empty SAFETY.md is allowed).
 * - Non-empty content that is not a substring of the prompt throws. Partial or missing injection is
 *   a hard failure and the caller aborts the turn/boot; medical safety outranks resilience.
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
