import { InvariantViolationError } from '../shared/errors';

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
