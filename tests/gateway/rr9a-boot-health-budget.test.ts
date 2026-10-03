import type { EffectiveConfig } from '../../src/config/types';

const mockCheckSystemReadiness = jest.fn();
const mockProbeChatCompletion = jest.fn();
jest.mock('../../src/providers/healthcheck', () => ({
  checkSystemReadiness: (...args: unknown[]) => mockCheckSystemReadiness(...args),
  probeChatCompletion: (...args: unknown[]) => mockProbeChatCompletion(...args),
}));

import { Gateway } from '../../src/gateway/gateway';

const CHAT_BINDING = 'owner-chat';

describe('RR-9a R6-23 Gateway boot health budget', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not hold boot on a never-settling health batch and reports pending state', async () => {
    jest.useFakeTimers();
    mockCheckSystemReadiness.mockImplementation(() => new Promise(() => undefined));
    mockProbeChatCompletion.mockImplementation(() => new Promise(() => undefined));
    // A purely structural double: this suite exercises `runBootHealthchecks` on a Gateway that is never
    // started and never serves. S1 makes admission REQUIRED on the constructor, so a minimal structural
    // authority is supplied rather than weakening the type back to optional.
    const gateway = new Gateway({} as EffectiveConfig, { admission: {} as never, ownerId: CHAT_BINDING as never });
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
