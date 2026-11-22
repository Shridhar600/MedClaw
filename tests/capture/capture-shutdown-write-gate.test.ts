import * as fs from 'fs';
import * as path from 'path';
import { WriteQueue } from '../../src/profiles';
import { MutationCoordinator } from '../../src/capture';
import { DaemonShutdownError } from '../../src/shared/errors';
import { makeTestTemp } from '../helpers/test-temp';

describe('MutationCoordinator isShutdown write-gate', () => {
  let root: string;
  let queue: WriteQueue;

  beforeEach(() => {
    root = makeTestTemp('redacted-coordinator-');
    queue = new WriteQueue({ journalPath: path.join(root, 'write-queue.journal') });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('enqueue rejects with DaemonShutdownError when isShutdown is true, without ever touching the WriteQueue', async () => {
    const enqueueSpy = jest.spyOn(queue, 'enqueue');
    const coordinator = new MutationCoordinator(queue, () => true);
    const run = jest.fn().mockResolvedValue('should-not-run');

    const attempt = async (): Promise<unknown> => coordinator.enqueue('turn', { label: 'late-write', run });
    await expect(attempt()).rejects.toBeInstanceOf(DaemonShutdownError);
    expect(run).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('mutate rejects with DaemonShutdownError when isShutdown is true, without ever touching the WriteQueue', async () => {
    const enqueueSpy = jest.spyOn(queue, 'enqueue');
    const coordinator = new MutationCoordinator(queue, () => true);
    const run = jest.fn().mockResolvedValue('should-not-run');

    const attempt = async (): Promise<unknown> => coordinator.mutate('turn', { id: 'x', label: 'late-mutate', run });
    await expect(attempt()).rejects.toBeInstanceOf(DaemonShutdownError);
    expect(run).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('selfHeal rejects with DaemonShutdownError when isShutdown is true, without ever touching the WriteQueue', async () => {
    const enqueueSpy = jest.spyOn(queue, 'enqueue');
    const coordinator = new MutationCoordinator(queue, () => true);
    const run = jest.fn().mockResolvedValue('should-not-run');

    const attempt = async (): Promise<unknown> => coordinator.selfHeal('safety-projection', run);
    await expect(attempt()).rejects.toBeInstanceOf(DaemonShutdownError);
    expect(run).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('a real caller pattern (try/await inside an async function, matching every production call site) catches the gate cleanly', async () => {
    const coordinator = new MutationCoordinator(queue, () => true);
    let caught: unknown;
    try {
      await coordinator.mutate('turn', { id: 'a', label: 'ledger-write', run: async () => 'unused' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DaemonShutdownError);
  });

  it('the rejection carries the PHI-free op label for sanitized diagnostics', async () => {
    const coordinator = new MutationCoordinator(queue, () => true);
    const attempt = async (): Promise<unknown> =>
      coordinator.mutate('turn', { id: 'ledger:medication', label: 'ledger-write', run: async () => undefined });
    await expect(attempt()).rejects.toMatchObject({ label: 'ledger-write' });
  });

  it('a live (isShutdown false) coordinator is unaffected — normal writes still succeed', async () => {
    const coordinator = new MutationCoordinator(queue, () => false);
    await expect(coordinator.mutate('turn', { id: 'a', label: 'ok', run: async () => 'result' }))
      .resolves.toBe('result');
  });

  it('the default constructor (no isShutdown arg) never gates — behavior-preserving default for every existing call site', async () => {
    const coordinator = new MutationCoordinator(queue);
    await expect(coordinator.enqueue('turn', { label: 'ok', run: async () => 'result' }))
      .resolves.toBe('result');
  });

  it('drain is never gated by isShutdown — draining must remain possible during/after shutdown', async () => {
    const coordinator = new MutationCoordinator(queue, () => true);
    await expect(coordinator.drain()).resolves.toBeUndefined();
  });
});
