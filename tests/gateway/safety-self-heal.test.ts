import * as fs from 'fs';
import * as path from 'path';
import { makeSelfHealingSafetyReader } from '../../src/gateway/runtime';
import { LedgerStore, SafetyView, SafetyProjectionDirtyError } from '../../src/memcore';
import { MutationCoordinator } from '../../src/capture';
import { WriteQueue } from '../../src/profiles';
import { mutableClock } from '../helpers/memcore-fixtures';
import { makeTestTemp } from '../helpers/test-temp';

describe('SAFETY self-heal', () => {
  let tmp: string;
  let ledger: LedgerStore;
  let view: SafetyView;
  let coordinator: MutationCoordinator;

  beforeEach(async () => {
    tmp = makeTestTemp('redacted-selfheal-');
    const clock = mutableClock('2026-08-20T10:00:00.000Z');
    ledger = new LedgerStore(tmp, clock);
    view = new SafetyView(tmp, clock, () => ledger.listSafetyRelevant());
    coordinator = new MutationCoordinator(new WriteQueue({ journalPath: path.join(tmp, 'write-queue.journal') }));
    await ledger.recordFact({
      entity: 'penicillin', type: 'allergy', fields: {}, safetyRelevant: true,
      provenance: { source: 'user', confidence: 1, anchor: '', capturedAt: '2026-08-20T09:00:00.000Z' },
    });
    await view.render(await ledger.listSafetyRelevant());
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('a dirty projection fails closed with SafetyProjectionDirtyError when read RAW (no self-heal)', async () => {
    view.markDirty();
    await expect(view.read()).rejects.toBeInstanceOf(SafetyProjectionDirtyError);
  });

  it('a drift-detecting read self-heals via ONE top-level coordinator op and succeeds', async () => {
    view.markDirty();
    const healSpy = jest.spyOn(coordinator, 'selfHeal');
    const reader = makeSelfHealingSafetyReader(view, () => ledger.listSafetyRelevant(), coordinator);

    const content = await reader.read();
    expect(content).toContain('penicillin');
    expect(healSpy).toHaveBeenCalledTimes(1);
    expect(healSpy.mock.calls[0][0]).toBe('safety-projection');
    await expect(view.read()).resolves.toContain('penicillin');
  });

  it('a self-heal that itself fails propagates the ORIGINAL dirty error ONCE — never spins', async () => {
    view.markDirty();
    const brokenSource = (): Promise<never> => Promise.reject(new Error('ledger unavailable during heal'));
    const healSpy = jest.spyOn(coordinator, 'selfHeal');
    const readSpy = jest.spyOn(view, 'read');
    const reader = makeSelfHealingSafetyReader(view, brokenSource, coordinator);

    await expect(reader.read()).rejects.toBeInstanceOf(SafetyProjectionDirtyError);
    expect(healSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('a healthy (non-dirty) read never touches self-heal at all', async () => {
    const healSpy = jest.spyOn(coordinator, 'selfHeal');
    const reader = makeSelfHealingSafetyReader(view, () => ledger.listSafetyRelevant(), coordinator);
    await expect(reader.read()).resolves.toContain('penicillin');
    expect(healSpy).not.toHaveBeenCalled();
  });

  it('a non-drift error (not SafetyProjectionDirtyError) is NEVER routed through self-heal — propagates as-is', async () => {
    const boom = new Error('unrelated I/O failure');
    jest.spyOn(view, 'read').mockRejectedValueOnce(boom);
    const healSpy = jest.spyOn(coordinator, 'selfHeal');
    const reader = makeSelfHealingSafetyReader(view, () => ledger.listSafetyRelevant(), coordinator);
    await expect(reader.read()).rejects.toBe(boom);
    expect(healSpy).not.toHaveBeenCalled();
  });
});
