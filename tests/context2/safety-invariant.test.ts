import { assertSafetyInjected } from '../../src/context2';
import { InvariantViolationError } from '../../src/shared/errors';

describe('assertSafetyInjected (PLAT-04 / PLAT-05)', () => {
  const SAFETY = '# SAFETY\n- ALLERGY: penicillin — anaphylaxis\n- MED: warfarin 5mg';

  it('passes when the full safety content is present in the prompt', () => {
    const prompt = `## SAFETY.md\n\n${SAFETY}\n\n---\n\n## SOUL.md\n\nbe kind`;
    expect(() => assertSafetyInjected(prompt, SAFETY)).not.toThrow();
  });

  it('throws InvariantViolationError when non-empty safety content is missing entirely', () => {
    const prompt = '## SOUL.md\n\nbe kind';
    expect(() => assertSafetyInjected(prompt, SAFETY)).toThrow(InvariantViolationError);
  });

  it('throws when safety content is present only partially (truncated)', () => {
    // Only the first line survived — a truncated injection must still fail the invariant.
    const prompt = `## SAFETY.md\n\n# SAFETY\n- ALLERGY: penicillin — anaphylaxis`;
    expect(() => assertSafetyInjected(prompt, SAFETY)).toThrow(InvariantViolationError);
  });

  it('is a no-op when safety content is empty', () => {
    expect(() => assertSafetyInjected('anything', '')).not.toThrow();
  });

  it('is a no-op when safety content is whitespace-only', () => {
    expect(() => assertSafetyInjected('anything', '   \n\t  ')).not.toThrow();
  });

  it('is a no-op when safety content is null/undefined', () => {
    expect(() => assertSafetyInjected('anything', null)).not.toThrow();
    expect(() => assertSafetyInjected('anything', undefined)).not.toThrow();
  });

  it('does not throw on an empty prompt when safety content is also empty', () => {
    expect(() => assertSafetyInjected('', '')).not.toThrow();
  });
});
