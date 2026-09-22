import { DEFAULT_CONFIG } from '../../src/config/defaults';

describe('sessions.window config defaults (spec 14 §3 / DD10)', () => {
  it('provides the window trigger defaults 35 / 50 / 80 / 10', () => {
    expect(DEFAULT_CONFIG.sessions.window).toEqual({
      pruneAtPercent: 35,
      compactAtPercent: 50,
      emergencyAtPercent: 80,
      keepRecentTurns: 10,
    });
  });
});
