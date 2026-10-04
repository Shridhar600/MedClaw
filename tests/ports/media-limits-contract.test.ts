// tests/ports/media-limits-contract.test.ts
//
// The protected invariant: **the locked media safety bounds are the DEFAULTS, and they are the values
// plan 15 §2.5 specifies.** Reported untested in review round 2, and the gap matters more than a
// typical untested constant: these are the numbers that decide whether one owner upload can exhaust
// memory, hold a slot forever, or exceed the cap while streaming.
//
// Every test in `tests/runtime/media-stager.test.ts` passes EXPLICIT limits — which is right, because
// a test that wants a 40 ms timeout must not wait 30 s. The consequence is that nothing anywhere
// asserted the production defaults, so a limit could be widened and the suite stay green.
//
// This is a contract pin, deliberately narrow: the values themselves, and the fact that
// `DEFAULT_MEDIA_LIMITS` is wired from them rather than restated.

import {
  DEFAULT_MEDIA_LIMITS,
  MEDIA_INTAKE_TIMEOUT_MS,
  MEDIA_MAX_ACTIVE,
  MEDIA_MAX_FILE_BYTES,
  MEDIA_MAX_WAITING,
} from '../../src/ports/media-source';

describe('media limits are the locked plan 15 2.5 bounds', () => {
  it('pins each safety bound to the value the plan specifies', () => {
    // 10 MiB per file, enforced while streaming rather than trusting an advertised size.
    expect(MEDIA_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    // 30 seconds for the WHOLE intake, queue wait included — not per phase.
    expect(MEDIA_INTAKE_TIMEOUT_MS).toBe(30_000);
    // One download in flight; four waiting. Both matter: `maxActive` bounds concurrent streaming and
    // `maxWaiting` bounds how many attempts can hold a timer and a queue slot each.
    expect(MEDIA_MAX_ACTIVE).toBe(1);
    expect(MEDIA_MAX_WAITING).toBe(4);
  });

  it('wires DEFAULT_MEDIA_LIMITS from those constants rather than restating them', () => {
    // If this ever diverges, the production defaults are no longer the plan's bounds.
    expect(DEFAULT_MEDIA_LIMITS).toEqual({
      maxFileBytes: MEDIA_MAX_FILE_BYTES,
      intakeTimeoutMs: MEDIA_INTAKE_TIMEOUT_MS,
      maxActive: MEDIA_MAX_ACTIVE,
      maxWaiting: MEDIA_MAX_WAITING,
    });
  });
});
