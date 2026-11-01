// `ProfileRuntimeManager` owns one `ProfileRuntime` per profile. It is a pure orchestration layer with no
// knowledge of paths or provider wiring: `Gateway` injects `buildRuntimeFor`. This class decides only when a
// build happens and how many run concurrently per profile, never what a runtime is built from.
//
// It lives with the gateway because `ProfileRuntime` bundles gateway-tier collaborators that the profiles
// module may not import.
import type { ProfileId } from '../profiles';
import { summarizeErrorForLog } from '../security';
import type { ProfileRuntime } from './runtime';

export type BuildRuntimeFor = (profileId: ProfileId) => Promise<ProfileRuntime>;

/**
 * Owns `Map<ProfileId, Promise<ProfileRuntime>>` (single-flight, promise-memoized), eager-built at boot for
 * every paired profile and retained for the daemon lifetime. A built runtime is never evicted while healthy;
 * only a failed build is evicted so the profile is not permanently bricked.
 */
export class ProfileRuntimeManager {
  /** Every build ever started for a profileId: in-flight, resolved, or (until evicted) rejected. */
  private readonly builds = new Map<ProfileId, Promise<ProfileRuntime>>();
  /** Successfully resolved runtimes only: the synchronous snapshot `all()` reads from. */
  private readonly resolvedRuntimes = new Map<ProfileId, ProfileRuntime>();
  /**
   * Settlement state per profile, tracked alongside `builds` because a Promise cannot be
   * introspected synchronously. Drives `pendingBuildCount()` for the shutdown disposition.
   */
  private readonly buildStatus = new Map<ProfileId, 'pending' | 'settled'>();
  private stopping = false;
  private drainPromise?: Promise<void>;

  constructor(private readonly buildRuntimeFor: BuildRuntimeFor) {}

  /**
   * Single-flight, promise-memoized: returns the existing in-flight/resolved promise for `profileId`, or
   * starts exactly one build and hands the same promise to every concurrent caller. A build that rejects
   * evicts its own entry from `builds`, so the next `get()` retries. Once `drainAndCloseAll()` has begun, no
   * new build starts (an in-flight or resolved build is still handed back, so shutdown drains it).
   */
  get(profileId: ProfileId): Promise<ProfileRuntime> {
    const existing = this.builds.get(profileId);
    if (existing) return existing;

    if (this.stopping) {
      return Promise.reject(
        new Error(`ProfileRuntimeManager is stopping; refusing to start a new build for profile "${profileId}"`),
      );
    }

    this.buildStatus.set(profileId, 'pending');
    const build = this.buildRuntimeFor(profileId).then(
      (runtime) => {
        this.resolvedRuntimes.set(profileId, runtime);
        this.buildStatus.set(profileId, 'settled');
        return runtime;
      },
      (error: unknown) => {
        this.builds.delete(profileId);
        this.buildStatus.set(profileId, 'settled');
        throw error;
      },
    );
    this.builds.set(profileId, build);
    return build;
  }

  /**
   * Eager-builds every profile in `profileIds`. Individually guarded: one profile's build failure is logged
   * (sanitized) and that profile is absent from `all()`. It never aborts the others or throws, so the daemon
   * does not crash because one profile's storage is broken.
   */
  async buildAll(profileIds: readonly ProfileId[]): Promise<void> {
    const unique = [...new Set(profileIds)];
    await Promise.allSettled(unique.map(async (profileId) => {
      try {
        await this.get(profileId);
      } catch (error) {
        console.error(
          `[gateway] Failed to build ProfileRuntime for profile "${profileId}"; that profile is degraded (not dispatchable this boot):`,
          summarizeErrorForLog(error),
        );
      }
    }));
  }

  /** The currently-built runtimes, for cross-runtime coordinators such as the nightly sweep. Excludes in-flight and failed builds. */
  all(): ProfileRuntime[] {
    return [...this.resolvedRuntimes.values()];
  }

  /**
   * How many build attempts have not settled yet.
   *
   * Ownership release must not happen while a construction continuation can still use owner
   * resources, so the shutdown disposition reads this. A rejected build that has not yet been
   * evicted still counts, because its continuation has not finished running.
   */
  pendingBuildCount(): number {
    let pending = 0;
    for (const record of this.buildStatus.values()) {
      if (record === 'pending') pending += 1;
    }
    return pending;
  }

  /** Whether a drain has begun. After this, no new build is accepted. */
  get isStopping(): boolean {
    return this.stopping;
  }

  /**
   * Synchronous snapshot read of ONE built runtime. The timer-driven reconcile path must resolve without an
   * async hop: an awaited `get()` would defer timer scheduling past the debounce window and could build a
   * runtime from a best-effort background tick. Returns `undefined` for in-flight/failed/unknown profiles;
   * callers treat that as "nothing to reconcile right now".
   */
  getIfBuilt(profileId: ProfileId): ProfileRuntime | undefined {
    return this.resolvedRuntimes.get(profileId);
  }

  /**
   * Stops new builds, awaits every in-flight/resolved build promise (`allSettled`, so a build racing
   * shutdown is drained rather than orphaned), then calls each built runtime's own `drainAndClose()`.
   * Per-runtime teardown stays inside `ProfileRuntime`; this only orchestrates across runtimes.
   * Idempotent: a second call returns the same drain promise.
   */
  async drainAndCloseAll(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.stopping = true;
    this.drainPromise = this.performDrain();
    return this.drainPromise;
  }

  private async performDrain(): Promise<void> {
    const settled = await Promise.allSettled([...this.builds.values()]);
    await Promise.allSettled(settled.map(async (result) => {
      if (result.status !== 'fulfilled') return;
      try {
        await result.value.drainAndClose();
      } catch (error) {
        console.warn('[gateway] Failed to drain/close a profile runtime:', summarizeErrorForLog(error));
      }
    }));
  }
}
