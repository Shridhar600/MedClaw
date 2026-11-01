import { DEFAULT_SESSION_WINDOW, cloneStoredDefaults } from '../../src/config/defaults';

describe('sessions.window config defaults', () => {
  it('provides the window trigger defaults 35 / 50 / 80 / 10', () => {
    expect(DEFAULT_SESSION_WINDOW).toEqual({
      pruneAtPercent: 35,
      compactAtPercent: 50,
      emergencyAtPercent: 80,
      keepRecentTurns: 10,
    });
  });

  it('hands out an independent copy so a caller cannot mutate the shared defaults', () => {
    const first = cloneStoredDefaults();
    first.sessions.window = { pruneAtPercent: 1, compactAtPercent: 2, emergencyAtPercent: 3, keepRecentTurns: 1 };

    expect(cloneStoredDefaults().sessions.window).toEqual(DEFAULT_SESSION_WINDOW);
  });
});
