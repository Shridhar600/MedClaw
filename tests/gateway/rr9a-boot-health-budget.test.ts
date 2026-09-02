import type { AppConfig } from '../../src/config/types';

const mockCheckSystemReadiness = jest.fn();
const mockProbeChatCompletion = jest.fn();
jest.mock('../../src/providers/healthcheck', () => ({
  checkSystemReadiness: (...args: unknown[]) => mockCheckSystemReadiness(...args),
  probeChatCompletion: (...args: unknown[]) => mockProbeChatCompletion(...args),
}));

import { Gateway } from '../../src/gateway/gateway';

describe('RR-9a R6-23 Gateway boot health budget', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not hold boot on a never-settling health batch and reports pending state', async () => {
    jest.useFakeTimers();
    mockCheckSystemReadiness.mockImplementation(() => new Promise(() => undefined));
    mockProbeChatCompletion.mockImplementation(() => new Promise(() => undefined));
    const gateway = new Gateway({} as AppConfig);
    const internals = gateway as unknown as {
      runBootHealthchecks(): Promise<void>;
      bootHealth?: { providers: Array<{ reasonCode?: string }> };
      buildBootStatusText(): string;
    };
    let completed = false;

    void internals.runBootHealthchecks().then(() => { completed = true; });
    await jest.advanceTimersByTimeAsync(3_001);

    expect(completed).toBe(true);
    expect(internals.bootHealth?.providers.every((provider) => provider.reasonCode === 'healthcheck-timeout')).toBe(true);
    expect(internals.buildBootStatusText()).toContain('PENDING');
  });
});
