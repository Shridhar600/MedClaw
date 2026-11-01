import type { ProfileId } from '../profiles';
import { summarizeErrorForLog } from '../security';
import type { ProfileRuntime } from './runtime';

export type BuildRuntimeFor = (profileId: ProfileId) => Promise<ProfileRuntime>;

export class ProfileRuntimeManager {
  /** Every build ever started for a profileId: in-flight, resolved, or (until evicted) rejected. */
  private readonly builds = new Map<ProfileId, Promise<ProfileRuntime>>();
  /** Successfully resolved runtimes only: the synchronous snapshot `all()` reads from. */
  private readonly resolvedRuntimes = new Map<ProfileId, ProfileRuntime>();
  private readonly buildStatus = new Map<ProfileId, 'pending' | 'settled'>();
  private stopping = false;
  private drainPromise?: Promise<void>;

  constructor(private readonly buildRuntimeFor: BuildRuntimeFor) {}

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

  getIfBuilt(profileId: ProfileId): ProfileRuntime | undefined {
    return this.resolvedRuntimes.get(profileId);
  }

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
