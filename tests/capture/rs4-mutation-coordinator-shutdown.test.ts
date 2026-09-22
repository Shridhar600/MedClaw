import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WriteQueue } from '../../src/profiles';
import { MutationCoordinator } from '../../src/capture';
import { DaemonShutdownError } from '../../src/shared/errors';

// RR-STRUCT R-S4 (mini-plan v3 §3.9, closes C-27 core): the MutationCoordinator is the choke
// point for every ledger/episode/safety/memory/capture write (post-R-S3). A write attempted
// after the owning ProfileRuntime has closed its SQLite handles must be refused with a typed,
// HANDLED `DaemonShutdownError` — BEFORE ever touching the underlying WriteQueue — never allowed
// to reach a closed native handle.
//
// NOTE on synchronous-throw semantics: `enqueue`/`mutate`/`selfHeal` are plain (non-`async`)
// methods, matching the PRE-EXISTING `assertNotReentrant` pattern (ReentrantMutationError is also
// thrown synchronously, by design — "failing fast... turns a hang into a diagnosable programming
// error"). A synchronous throw from a non-async method escapes the IMMEDIATE call, not as a
// promise rejection, UNLESS the call itself happens inside an `async` function body or a `try`
// block — which is exactly how every real caller invokes these methods (verified: CapturePipeline
// .ingest, every tool's `async execute()`, makeSelfHealingSafetyReader.read — see report §"hunted
// beyond the brief"). These tests therefore wrap each call the same way a real caller would
// (inside an async arrow / a try), never asserting directly on the bare call expression.
describe('RR-STRUCT R-S4 — MutationCoordinator isShutdown write-gate', () => {
  let root: string;
  let queue: WriteQueue;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs4-coordinator-'));
    queue = new WriteQueue({ journalPath: path.join(root, 'write-queue.journal') });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('enqueue() rejects with DaemonShutdownError when isShutdown() is true, without ever touching the WriteQueue', async () => {
    const enqueueSpy = jest.spyOn(queue, 'enqueue');
    const coordinator = new MutationCoordinator(queue, () => true);
    const run = jest.fn().mockResolvedValue('should-not-run');

    const attempt = async (): Promise<unknown> => coordinator.enqueue('turn', { label: 'late-write', run });
    await expect(attempt()).rejects.toBeInstanceOf(DaemonShutdownError);
    expect(run).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('mutate() rejects with DaemonShutdownError when isShutdown() is true, without ever touching the WriteQueue', async () => {
    const enqueueSpy = jest.spyOn(queue, 'enqueue');
    const coordinator = new MutationCoordinator(queue, () => true);
    const run = jest.fn().mockResolvedValue('should-not-run');

    const attempt = async (): Promise<unknown> => coordinator.mutate('turn', { id: 'x', label: 'late-mutate', run });
    await expect(attempt()).rejects.toBeInstanceOf(DaemonShutdownError);
    expect(run).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('selfHeal() rejects with DaemonShutdownError when isShutdown() is true, without ever touching the WriteQueue', async () => {
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
    // Mirrors ledger-tools.ts's `try { const fact = await deps.queue.enqueue(...) } catch {...}`
    // and every tool's `async execute()` wrapping a bare `await coordinator.X(...)` call.
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

  it('a live (isShutdown() false) coordinator is unaffected — normal writes still succeed', async () => {
    const coordinator = new MutationCoordinator(queue, () => false);
    await expect(coordinator.mutate('turn', { id: 'a', label: 'ok', run: async () => 'result' }))
      .resolves.toBe('result');
  });

  it('the default constructor (no isShutdown arg) never gates — behavior-preserving default for every existing call site', async () => {
    const coordinator = new MutationCoordinator(queue);
    await expect(coordinator.enqueue('turn', { label: 'ok', run: async () => 'result' }))
      .resolves.toBe('result');
  });

  it('drain() is never gated by isShutdown — draining must remain possible during/after shutdown', async () => {
    const coordinator = new MutationCoordinator(queue, () => true);
    await expect(coordinator.drain()).resolves.toBeUndefined();
  });
});
