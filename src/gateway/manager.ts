// src/gateway/manager.ts
//
// RR-STRUCT R-S5a (mini-plan v3 §3.3, Finding-7): `ProfileRuntimeManager` owns one `ProfileRuntime`
// per profile. It is a PURE orchestration layer — zero knowledge of paths, migration, or provider
// wiring. `Gateway` (the composition root) injects `buildRuntimeFor`, which keeps every path-
// resolution + migration decision on the Gateway side (the standing "Gateway resolves paths,
// stores are path-agnostic" invariant). This class only decides WHEN a build happens and how many
// concurrent builds are allowed per profile — never WHAT a runtime is built from.
//
// Lives in src/gateway/ (legacy/gateway-tier), not src/profiles/ (v2-core): `.dependency-
// cruiser.cjs`'s `v2-core-boundary` rule forbids a v2-core module from importing legacy modules,
// and `ProfileRuntime` bundles legacy-tier collaborators (AgentLoop, SessionManager, SqliteStore,
// ...) — so the manager must live at the composition root alongside `runtime.ts`, for the same
// reason `runtime.ts` does (mini-plan v3 §3.3).
import type { ProfileId } from '../profiles';
import { summarizeErrorForLog } from '../security';
import type { ProfileRuntime } from './runtime';

export type BuildRuntimeFor = (profileId: ProfileId) => Promise<ProfileRuntime>;

/**
 * Owns `Map<ProfileId, Promise<ProfileRuntime>>` (single-flight, promise-memoized), eager-built
 * at boot for every paired profile, retained for the daemon lifetime (no LRU — R-S5a scope: a
 * built runtime is never evicted while healthy, only a FAILED build is evicted so the profile
 * isn't permanently bricked).
 */
export class ProfileRuntimeManager {
  /** Every build ever started for a profileId — in-flight, resolved, OR (transiently, until the
   *  rejection-evict runs) rejected. The single-flight memoization table. */
  private readonly builds = new Map<ProfileId, Promise<ProfileRuntime>>();
  /** Successfully resolved runtimes only — the synchronous "currently-built" snapshot `all()`
   *  reads from (a Promise cannot be introspected synchronously, so this is tracked separately). */
  private readonly resolvedRuntimes = new Map<ProfileId, ProfileRuntime>();
  private stopping = false;
  private drainPromise?: Promise<void>;

  constructor(private readonly buildRuntimeFor: BuildRuntimeFor) {}

  /**
   * Single-flight, promise-memoized: returns the existing in-flight/resolved promise for
   * `profileId`, or starts exactly ONE build and hands the same promise to every concurrent
   * caller. A build that REJECTS evicts its own entry from `builds` (Finding-7a) so a transient
   * boot failure never permanently bricks the profile — the NEXT `get()` retries a fresh build.
   * Once `drainAndCloseAll()` has begun, refuses to start a NEW build (an already in-flight or
   * resolved build is still handed back — it is drained by shutdown, never orphaned).
   */
  get(profileId: ProfileId): Promise<ProfileRuntime> {
    const existing = this.builds.get(profileId);
    if (existing) return existing;

    if (this.stopping) {
      return Promise.reject(
        new Error(`ProfileRuntimeManager is stopping; refusing to start a new build for profile "${profileId}"`),
      );
    }

    const build = this.buildRuntimeFor(profileId).then(
      (runtime) => {
        this.resolvedRuntimes.set(profileId, runtime);
        return runtime;
      },
      (error: unknown) => {
        this.builds.delete(profileId);
        throw error;
      },
    );
    this.builds.set(profileId, build);
    return build;
  }

  /**
   * Eager-builds every profile in `profileIds` up front. Individually guarded: one profile's
   * build failure is logged (sanitized) and that profile is simply absent from `all()` — it must
   * never abort the others or throw out of `buildAll` (resilience: the daemon never crashes
   * because one profile's storage is broken; that profile just isn't dispatchable this boot).
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

  /** The currently-built (successfully resolved) runtimes — for cross-runtime coordinators such
   *  as the nightly sweep (Part C). Excludes in-flight and failed builds. */
  all(): ProfileRuntime[] {
    return [...this.resolvedRuntimes.values()];
  }

  /**
   * RR-STRUCT R-S5b: synchronous snapshot read of ONE built runtime. The timer-driven
   * reconcile path (`debouncedReconcile`/`launchBackgroundReconcile`) must resolve without an
   * async hop — an awaited `get()` would defer the `setTimeout` scheduling past the debounce
   * window's synchronous timer semantics (and could on-demand BUILD a runtime from a
   * best-effort background tick). Returns `undefined` for in-flight/failed/unknown profiles;
   * callers treat that as "nothing to reconcile right now" (the next served turn retries).
   */
  getIfBuilt(profileId: ProfileId): ProfileRuntime | undefined {
    return this.resolvedRuntimes.get(profileId);
  }

  /**
   * Stops new builds (`stopping = true`, so no NEW `get()` for an unseen profile starts a build
   * mid-shutdown — Finding-7b), awaits EVERY in-flight/resolved build promise (`allSettled`, so a
   * build racing shutdown is drained rather than orphaned — its handles get closed the instant it
   * finishes), then calls each successfully-built runtime's own R-S4 `drainAndClose()`. Does not
   * reimplement per-runtime teardown — that stays entirely inside `ProfileRuntime`; this method
   * only orchestrates ACROSS runtimes. Idempotent: a second call returns the SAME drain promise
   * (mirrors `Gateway.stop()`'s own `stopPromise` memoization pattern).
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
