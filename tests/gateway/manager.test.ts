import { ProfileRuntimeManager } from '../../src/gateway/manager';
import type { ProfileRuntime } from '../../src/gateway/runtime';
import type { ProfileId } from '../../src/profiles/types';

// RR-STRUCT R-S5a (mini-plan v3 §3.3, Finding-7): pure unit tests for the manager's orchestration
// contract in isolation from Gateway/ProfileRuntime construction — single-flight, rejection-evict,
// buildAll individual-guarding, and drainAndCloseAll's drain-in-flight + idempotency semantics.

function fakeRuntime(profileId: string, overrides: Partial<ProfileRuntime> = {}): ProfileRuntime {
  return {
    profileId: profileId as ProfileId,
    drainAndClose: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ProfileRuntime;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('ProfileRuntimeManager (RR-STRUCT R-S5a, mini-plan v3 §3.3)', () => {
  describe('single-flight get()', () => {
    it('concurrent get(id) calls yield ONE build (buildRuntimeFor called exactly once)', async () => {
      const runtime = fakeRuntime('default');
      const buildRuntimeFor = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(runtime), 5)),
      );
      const manager = new ProfileRuntimeManager(buildRuntimeFor);

      const [a, b] = await Promise.all([
        manager.get('default' as ProfileId),
        manager.get('default' as ProfileId),
      ]);

      expect(buildRuntimeFor).toHaveBeenCalledTimes(1);
      expect(a).toBe(runtime);
      expect(b).toBe(runtime);
    });

    it('two DIFFERENT profileIds each get their own independent build', async () => {
      const runtimeA = fakeRuntime('a');
      const runtimeB = fakeRuntime('b');
      const buildRuntimeFor = jest.fn().mockImplementation((id: ProfileId) =>
        Promise.resolve(id === 'a' ? runtimeA : runtimeB));
      const manager = new ProfileRuntimeManager(buildRuntimeFor);

      const [a, b] = await Promise.all([
        manager.get('a' as ProfileId),
        manager.get('b' as ProfileId),
      ]);

      expect(buildRuntimeFor).toHaveBeenCalledTimes(2);
      expect(a).toBe(runtimeA);
      expect(b).toBe(runtimeB);
    });
  });

  describe('rejection-evict (Finding-7a)', () => {
    it('a build that rejects evicts its promise so the NEXT get() retries a fresh build', async () => {
      const runtime = fakeRuntime('default');
      const buildRuntimeFor = jest.fn()
        .mockRejectedValueOnce(new Error('transient boot failure'))
        .mockResolvedValueOnce(runtime);
      const manager = new ProfileRuntimeManager(buildRuntimeFor);

      await expect(manager.get('default' as ProfileId)).rejects.toThrow('transient boot failure');
      expect(buildRuntimeFor).toHaveBeenCalledTimes(1);

      const resolved = await manager.get('default' as ProfileId);
      expect(resolved).toBe(runtime);
      expect(buildRuntimeFor).toHaveBeenCalledTimes(2);
    });

    it('a persistently-failing profile never bricks other profiles (each id evicts independently)', async () => {
      const runtimeB = fakeRuntime('b');
      const buildRuntimeFor = jest.fn().mockImplementation((id: ProfileId) =>
        id === 'a' ? Promise.reject(new Error('a is broken')) : Promise.resolve(runtimeB));
      const manager = new ProfileRuntimeManager(buildRuntimeFor);

      await expect(manager.get('a' as ProfileId)).rejects.toThrow('a is broken');
      const b = await manager.get('b' as ProfileId);
      expect(b).toBe(runtimeB);
    });
  });

  describe('buildAll — eager, individually guarded', () => {
    it('builds every profile up front; one failure does not abort the others or throw', async () => {
      const runtimeA = fakeRuntime('a');
      const runtimeC = fakeRuntime('c');
      const buildRuntimeFor = jest.fn().mockImplementation((id: ProfileId) => {
        if (id === 'b') return Promise.reject(new Error('b storage is corrupt'));
        return Promise.resolve(id === 'a' ? runtimeA : runtimeC);
      });
      const manager = new ProfileRuntimeManager(buildRuntimeFor);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(manager.buildAll(['a', 'b', 'c'] as ProfileId[])).resolves.toBeUndefined();

      expect(buildRuntimeFor).toHaveBeenCalledTimes(3);
      const built = manager.all();
      expect(built).toContain(runtimeA);
      expect(built).toContain(runtimeC);
      expect(built).toHaveLength(2);
      expect(errorSpy.mock.calls.flat().some((c) => typeof c === 'string' && c.includes('"b"'))).toBe(true);
      errorSpy.mockRestore();
    });

    it('de-duplicates repeated profileIds in the input list (single build per id)', async () => {
      const buildRuntimeFor = jest.fn().mockResolvedValue(fakeRuntime('default'));
      const manager = new ProfileRuntimeManager(buildRuntimeFor);

      await manager.buildAll(['default', 'default', 'default'] as ProfileId[]);

      expect(buildRuntimeFor).toHaveBeenCalledTimes(1);
    });
  });

  describe('all() — currently-built snapshot', () => {
    it('excludes in-flight and failed builds; includes only resolved runtimes', async () => {
      const runtime = fakeRuntime('resolved');
      const pending = deferred<ProfileRuntime>();
      const buildRuntimeFor = jest.fn().mockImplementation((id: ProfileId) => {
        if (id === 'resolved') return Promise.resolve(runtime);
        if (id === 'failed') return Promise.reject(new Error('nope'));
        return pending.promise; // 'inflight' never resolves during this test
      });
      const manager = new ProfileRuntimeManager(buildRuntimeFor);

      await manager.get('resolved' as ProfileId);
      await manager.get('failed' as ProfileId).catch(() => undefined);
      void manager.get('inflight' as ProfileId); // fire-and-forget, still pending

      expect(manager.all()).toEqual([runtime]);
    });
  });

  describe('drainAndCloseAll (Finding-7b, v3 §3.9)', () => {
    it('closes every resolved runtime exactly once', async () => {
      const runtimeA = fakeRuntime('a');
      const runtimeB = fakeRuntime('b');
      const buildRuntimeFor = jest.fn().mockImplementation((id: ProfileId) =>
        Promise.resolve(id === 'a' ? runtimeA : runtimeB));
      const manager = new ProfileRuntimeManager(buildRuntimeFor);
      await manager.buildAll(['a', 'b'] as ProfileId[]);

      await manager.drainAndCloseAll();

      expect(runtimeA.drainAndClose).toHaveBeenCalledTimes(1);
      expect(runtimeB.drainAndClose).toHaveBeenCalledTimes(1);
    });

    it('awaits a build still in flight at shutdown before closing it — no orphaned handle', async () => {
      const runtime = fakeRuntime('slow');
      const gate = deferred<ProfileRuntime>();
      const buildRuntimeFor = jest.fn().mockReturnValue(gate.promise);
      const manager = new ProfileRuntimeManager(buildRuntimeFor);

      const getPromise = manager.get('slow' as ProfileId); // still in flight
      const drainPromise = manager.drainAndCloseAll(); // races the in-flight build

      // The build finishes AFTER drainAndCloseAll has started.
      await new Promise((r) => setTimeout(r, 5));
      expect(runtime.drainAndClose).not.toHaveBeenCalled();
      gate.resolve(runtime);

      await Promise.all([getPromise, drainPromise]);
      expect(runtime.drainAndClose).toHaveBeenCalledTimes(1);
    });

    it('a build that FAILS while racing shutdown is not closed (nothing to close) and does not throw', async () => {
      const gate = deferred<ProfileRuntime>();
      const buildRuntimeFor = jest.fn().mockReturnValue(gate.promise);
      const manager = new ProfileRuntimeManager(buildRuntimeFor);

      const getPromise = manager.get('slow' as ProfileId).catch(() => undefined);
      const drainPromise = manager.drainAndCloseAll();
      gate.reject(new Error('boot failed mid-shutdown'));

      await expect(Promise.all([getPromise, drainPromise])).resolves.toBeDefined();
    });

    it('double-stop is idempotent (second call returns the SAME drain, does not re-close)', async () => {
      const runtime = fakeRuntime('default');
      const manager = new ProfileRuntimeManager(() => Promise.resolve(runtime));
      await manager.get('default' as ProfileId);

      await manager.drainAndCloseAll();
      await manager.drainAndCloseAll();

      expect(runtime.drainAndClose).toHaveBeenCalledTimes(1);
    });

    it('refuses to start a NEW build for an unseen profile once stopping has begun', async () => {
      const manager = new ProfileRuntimeManager(() => Promise.resolve(fakeRuntime('x')));
      await manager.drainAndCloseAll();

      await expect(manager.get('never-built' as ProfileId)).rejects.toThrow(/stopping/i);
    });

    it('still hands back an ALREADY in-flight/resolved build after stopping has begun (drained, not refused)', async () => {
      const runtime = fakeRuntime('default');
      const manager = new ProfileRuntimeManager(() => Promise.resolve(runtime));
      const first = await manager.get('default' as ProfileId);
      void manager.drainAndCloseAll();

      const second = await manager.get('default' as ProfileId);
      expect(second).toBe(first);
    });

    it('a runtime whose drainAndClose rejects does not stop the others from being closed', async () => {
      const runtimeA = fakeRuntime('a', { drainAndClose: jest.fn().mockRejectedValue(new Error('close failed')) });
      const runtimeB = fakeRuntime('b');
      const buildRuntimeFor = jest.fn().mockImplementation((id: ProfileId) =>
        Promise.resolve(id === 'a' ? runtimeA : runtimeB));
      const manager = new ProfileRuntimeManager(buildRuntimeFor);
      await manager.buildAll(['a', 'b'] as ProfileId[]);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(manager.drainAndCloseAll()).resolves.toBeUndefined();

      expect(runtimeB.drainAndClose).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });
});
