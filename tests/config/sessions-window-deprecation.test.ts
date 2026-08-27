import { deprecatedSessionWarnings } from '../../src/config/deprecations';
import type { SessionsConfig } from '../../src/config/types';

const base: SessionsConfig = {
  softResetAfterMinutes: 240,
  hardResetAfterMinutes: 1440,
  compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
  window: { pruneAtPercent: 35, compactAtPercent: 50, emergencyAtPercent: 80, keepRecentTurns: 10 },
};

describe('deprecatedSessionWarnings (DD10 / A-L5)', () => {
  it('emits no warning when the deprecated idle-reset keys are at their defaults', () => {
    expect(deprecatedSessionWarnings(base)).toEqual([]);
  });

  it('warns when softResetAfterMinutes differs from the default (retired, inert)', () => {
    const w = deprecatedSessionWarnings({ ...base, softResetAfterMinutes: 120 });
    expect(w.some((m) => m.includes('softResetAfterMinutes'))).toBe(true);
  });

  it('warns when hardResetAfterMinutes differs from the default (retired, inert)', () => {
    const w = deprecatedSessionWarnings({ ...base, hardResetAfterMinutes: 999 });
    expect(w.some((m) => m.includes('hardResetAfterMinutes'))).toBe(true);
  });

  it('warns when sessions.compaction.keepRecentTurns is set without the new sessions.window key', () => {
    const noWindow: SessionsConfig = {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 7 },
    };
    const w = deprecatedSessionWarnings(noWindow);
    expect(w.some((m) => m.includes('sessions.window'))).toBe(true);
  });
});
