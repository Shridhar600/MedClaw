import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppConfig } from '../config/types';
import { ProfileRegistry } from '../profiles';
import type { ProfileId } from '../profiles';
import type { Channel, IncomingMessage } from '../channels/types';
import { TelegramChannel } from '../channels/telegram';
import { LLMSemaphore, HeartbeatQueueFullError } from '../tools/semaphore';
import { deprecatedSessionWarnings } from '../config/deprecations';
import { createProvider } from '../providers/factory';
import { SessionManager } from './session';
import { syncHeartbeatMarkdown } from '../scheduler/heartbeat-markdown';
import type { NightlySweepResult } from '../scheduler/transcript-sweep-job';
import type { HeartbeatJob } from '../scheduler/types';
import { decideHeartbeatDelivery, HEARTBEAT_NOOP } from '../scheduler/delivery-policy';
import { buildDesiredHeartbeatJobs } from '../scheduler/policy-engine';
import { reconcilePolicyJobs } from '../scheduler/reconciler';
import { ensureWorkspaceBootstrap } from '../workspace/bootstrap';
import { checkSystemReadiness, probeChatCompletion } from '../providers/healthcheck';
import type { ReadinessResult } from '../providers/healthcheck';
import type { LLMProvider } from '../providers/types';
import {
  checkProviderBindAddresses,
  verifyWorkspacePermissions,
  summarizeErrorForLog,
} from '../security';
import { ProfileRuntime } from './runtime';
import { ProfileRuntimeManager } from './manager';
import { GatewayMessageRouter, sweepStagedMedia } from './router';
import { TurnQueueFullError, heartbeatTurnId } from './turn-coordinator';

const SHUTDOWN_RESPONSE = 'The health assistant is shutting down. Please try again in a moment.';
const BOOT_HEALTHCHECK_BUDGET_MS = 3_000;

function pendingReadiness(label: string): ReadinessResult {
  return {
    ready: false,
    checked: true,
    label,
    status: 'warn',
    details: ['health check pending'],
    warnings: ['not completed within the startup budget'],
    reasonCode: 'healthcheck-timeout',
    actionHint: 'Health checks continue in the background; retry status shortly.',
  };
}

function pendingBootHealth(): { providers: ReadinessResult[]; telegram: ReadinessResult } {
  return {
    providers: ['main provider', 'medical provider', 'embeddings provider'].map(pendingReadiness),
    telegram: pendingReadiness('telegram'),
  };
}

function readinessLabel(result: ReadinessResult): 'OK' | 'FAIL' | 'PENDING' {
  if (result.reasonCode === 'healthcheck-timeout') return 'PENDING';
  return result.ready ? 'OK' : 'FAIL';
}

export class Gateway {
  private config: AppConfig;
  private channel?: Channel;
  private profileRegistry?: ProfileRegistry;
  private resolvedMemoryWorkspace?: string;
  private bootHealth?: { providers: ReadinessResult[]; telegram: ReadinessResult };
  private mainProvider?: LLMProvider;
  /** RR-STRUCT R-S5a: the medical-provider fallback used for medication side-effect lookups,
   *  shared across every profile's runtime (daemon-singleton per mini-plan v3 §3.1) — hoisted to
   *  a field (was a `start()`-local var) so `buildRuntimeFor` can close over it for any profile. */
  private sideEffectProvider?: LLMProvider;
  private securityWarnings: string[] = [];
  private reconcileTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private semaphore?: LLMSemaphore;
  private stopping = false;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private runtime?: ProfileRuntime;
  /** RR-STRUCT R-S5a (mini-plan v3 §3.3): owns one ProfileRuntime per paired profile. `this.runtime`
   *  above stays the DEFAULT profile's runtime (`manager.get(defaultProfileId)`) — every existing
   *  accessor/handler/Router keeps reading `this.runtime` unchanged; dispatch stays default-only
   *  (the RR-4 refusal is untouched — R-S5b routes by profile and retires it). */
  private manager?: ProfileRuntimeManager;
  private router?: GatewayMessageRouter;

  constructor(config: AppConfig) {
    this.config = config;
  }

  get runtimeInstance(): ProfileRuntime | undefined {
    return this.runtime;
  }

  /** Test/diagnostic seam (mirrors `runtimeInstance`): the manager owning every built profile's
   *  runtime. `undefined` until `start()` has run (or in the `attachGatewayTestRuntime` test-double
   *  seam, which never constructs one). */
  get runtimeManager(): ProfileRuntimeManager | undefined {
    return this.manager;
  }

  // Narrow test-backed seams. Setters require a runtime attached by ProfileRuntime.create
  // (or a structural runtime test double); they never construct one.
  get agentLoop(): ProfileRuntime['agentLoop'] {
    return this.runtime?.agentLoop;
  }
  set agentLoop(value: ProfileRuntime['agentLoop']) {
    this.requireRuntimeForAccess().agentLoop = value;
  }

  get sessions(): ProfileRuntime['sessions'] {
    return this.runtime?.sessions;
  }
  set sessions(value: ProfileRuntime['sessions']) {
    this.requireRuntimeForAccess().sessions = value;
  }

  get scheduler(): ProfileRuntime['scheduler'] {
    return this.runtime?.scheduler;
  }
  set scheduler(value: ProfileRuntime['scheduler']) {
    this.requireRuntimeForAccess().scheduler = value;
  }

  get store(): ProfileRuntime['store'] {
    return this.runtime?.store;
  }
  set store(value: ProfileRuntime['store']) {
    this.requireRuntimeForAccess().store = value;
  }

  get capturePipeline(): ProfileRuntime['capturePipeline'] {
    return this.runtime?.capturePipeline;
  }
  set capturePipeline(value: ProfileRuntime['capturePipeline']) {
    this.requireRuntimeForAccess().capturePipeline = value;
  }

  get factMirror(): ProfileRuntime['factMirror'] {
    return this.runtime?.factMirror;
  }

  get ledgerStore(): ProfileRuntime['ledgerStore'] {
    return this.runtime?.ledgerStore;
  }

  get curiosity(): ProfileRuntime['curiosity'] {
    return this.runtime?.curiosity;
  }

  get vectorIndex(): ProfileRuntime['vectorIndex'] {
    return this.runtime?.vectorIndex;
  }

  get keywordIndex(): ProfileRuntime['keywordIndex'] {
    return this.runtime?.keywordIndex;
  }

  get chunkStats(): ProfileRuntime['chunkStats'] {
    return this.runtime?.chunkStats;
  }

  async start(): Promise<void> {
    const { config } = this;
    const profilesConfig = config.profiles;
    const profileId = (profilesConfig?.defaultProfileId ?? 'default') as ProfileId;
    this.stopping = false;
    this.stopped = false;

    console.log('[gateway] Starting Redacted...');

    // P2b DD10 / D3.7: warn once at boot for any retired idle-reset config key still set to a
    // non-default value (they no longer trigger anything).
    for (const warning of deprecatedSessionWarnings(config.sessions)) {
      console.warn(`[gateway] Deprecated config: ${warning}`);
    }

    // Bootstrap workspace with template files on first run
    this.bootstrapWorkspace(config.memory.workspace);
    const stagingDir = this.mediaStagingDir();
    sweepStagedMedia(stagingDir, os.homedir());

    // Profiles: construct the registry. Legacy migration (idempotent) happens per-profile inside
    // buildRuntimeFor below, restricted to the DEFAULT profile only (RR-STRUCT R-S5a Part B,
    // mini-plan v3 §3.8 A-F04 — SAFETY-CRITICAL: a secondary profile must never see it).
    this.profileRegistry = profilesConfig ? this.tryCreateProfileRegistry(profilesConfig.baseDir) : undefined;

    const mainProvider = createProvider(config.providers.main);
    this.mainProvider = mainProvider;

    const semaphore = new LLMSemaphore();
    this.semaphore = semaphore;

    let sideEffectProvider: LLMProvider = mainProvider;
    try {
      sideEffectProvider = createProvider(config.providers.medical);
    } catch (error) {
      console.warn('[gateway] Medical provider for side-effect lookup unavailable; using main:', summarizeErrorForLog(error));
    }
    this.sideEffectProvider = sideEffectProvider;

    // Channel
    if (config.channels.telegram.enabled) {
      const token = config.channels.telegram.botToken || process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        throw new Error('TELEGRAM_BOT_TOKEN not set. Set it in config or environment.');
      }
      this.channel = new TelegramChannel(token, stagingDir, os.homedir());
      this.channel.onMessage((msg) => this.handleMessage(msg));
    }

    // RR-STRUCT R-S5a (mini-plan v3 §3.3): ProfileRuntimeManager owns one ProfileRuntime per
    // paired profile. The DEFAULT profile is built first and DIRECTLY (not via buildAll) so its
    // failure semantics stay byte-identical to pre-R-S5a: exactly one build attempt, and a
    // genuine failure propagates straight out of start() (see tests/gateway/memcore-wiring.test.ts
    // "aborts boot when the SAFETY.md injection invariant is violated"). Every OTHER paired
    // profile is then eager-built via buildAll — individually guarded, so a secondary profile's
    // broken storage degrades only that profile and never touches the default or aborts boot.
    this.manager = new ProfileRuntimeManager((id) => this.buildRuntimeFor(id));
    this.runtime = await this.manager.get(profileId);
    await this.manager.buildAll(this.pairedProfileIds(profileId));

    this.router = this.createRouter();
    if (this.channel && typeof this.channel.connect === 'function') {
      await this.channel.connect();
    }
    await this.initializeScheduler();

    await this.runBootHealthchecks();
    this.runSecurityChecks();

    console.log('[gateway] Redacted is running.');
  }

  /**
   * RR-STRUCT R-S5a Part C (mini-plan v3 §3.8 A-F07): a nightly-sweep COORDINATOR across every
   * built profile — each profile's own cron (`ProfileRuntime`'s internal `sweepTask`, R-S1)
   * already sweeps itself independently in production; this is the manual/test-triggered surface
   * (`gateway.runTranscriptSweep()`). Preserves the EXISTING external contract exactly: it still
   * returns the DEFAULT profile's `NightlySweepResult` (the shape every existing sweep test
   * asserts on), while additionally sweeping every OTHER built profile against its OWN sessions/
   * ledger/curiosity, individually guarded — one profile's sweep failure never aborts another's
   * (including the default's).
   */
  async runTranscriptSweep(): Promise<NightlySweepResult> {
    if (this.stopping) return { scanned: false, added: 0 };
    if (!this.manager) {
      // Test-double seam (attachGatewayTestRuntime): no manager was ever built.
      if (!this.runtime) return { scanned: false, added: 0 };
      return this.runtime.runTranscriptSweep();
    }
    const defaultProfileId = (this.config.profiles?.defaultProfileId ?? 'default') as ProfileId;
    const results = await this.sweepAllBuiltProfiles();
    return results.get(defaultProfileId) ?? { scanned: false, added: 0 };
  }

  private async sweepAllBuiltProfiles(): Promise<Map<ProfileId, NightlySweepResult>> {
    const out = new Map<ProfileId, NightlySweepResult>();
    const runtimes = this.manager?.all() ?? [];
    await Promise.allSettled(runtimes.map(async (runtime) => {
      try {
        out.set(runtime.profileId, await runtime.runTranscriptSweep());
      } catch (error) {
        console.warn(
          '[gateway] Nightly transcript sweep failed for a profile; other profiles are unaffected:',
          summarizeErrorForLog(error),
        );
        out.set(runtime.profileId, { scanned: false, added: 0 });
      }
    }));
    return out;
  }

  private async lookupSideEffects(provider: LLMProvider, entity: string): Promise<string[]> {
    try {
      const prompt =
        `List the well-known common side effects of the medication "${entity}" as a compact JSON ` +
        `array of short lowercase strings (e.g. ["nausea","dizziness"]). If unsure, return []. ` +
        `Output ONLY the JSON array.`;
      const res = await provider.chat([{ role: 'user', content: prompt }]);
      if (res.type !== 'text') return [];
      const match = res.text.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed: unknown = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((x): x is string => typeof x === 'string')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 20);
    } catch (e) {
      console.warn('[gateway] side-effect lookup failed (falling back to []):', summarizeErrorForLog(e));
      return [];
    }
  }

  async handleTestMessage(chatId: string, text: string, sourceMessageId?: string): Promise<string> {
    if (this.stopping) return SHUTDOWN_RESPONSE;
    return this.trackOperation(() => this.requireRouter().route(
      { chatId, userId: '', text, ...(sourceMessageId ? { messageId: sourceMessageId } : {}) },
      async () => undefined,
      false,
    ).then((response) => response ?? ''));
  }

  private async handleMessage(incoming: IncomingMessage): Promise<void> {
    if (this.stopping) return;
    try {
      await this.trackOperation(() => this.requireRouter().route(
        incoming,
        (text) => this.channel!.send(incoming.chatId, { text }),
      ));
    } catch (error) {
      console.error('[gateway] Handler error:', summarizeErrorForLog(error));
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.runtime?.beginStopping();
    const shared = this.stopResources().finally(() => {
      this.stopped = true;
      if (this.stopPromise === shared) this.stopPromise = undefined;
    });
    this.stopPromise = shared;
    return shared;
  }

  private async stopResources(): Promise<void> {
    for (const timer of this.reconcileTimers.values()) {
      clearTimeout(timer);
    }
    this.reconcileTimers.clear();
    let firstError: unknown;
    try {
      this.semaphore?.shutdown();
    } catch (error) {
      console.warn('[gateway] Failed to stop LLM semaphore:', summarizeErrorForLog(error));
    }
    try {
      await this.channel?.disconnect();
    } catch (error) {
      firstError = firstError ?? error;
      console.warn('[gateway] Failed to disconnect channel:', summarizeErrorForLog(error));
    }

    try {
      if (this.manager) {
        // RR-STRUCT R-S5a: drains + closes EVERY built profile's runtime (not just the default).
        await this.manager.drainAndCloseAll();
      } else {
        // Test-double seam (attachGatewayTestRuntime): start() never ran, so no manager exists —
        // fall back to closing the directly-attached runtime, exactly as pre-R-S5a.
        await this.runtime?.drainAndClose();
      }
    } catch (error) {
      firstError = firstError ?? error;
    }

    console.log('[gateway] Stopped.');
    if (firstError) {
      throw firstError;
    }
  }

  /**
   * RR-STRUCT R-S5b (mini-plan v3 §3.1 Finding-6, §3.8 A-F03; the R-S5a deferral): starts EACH
   * built profile's OWN heartbeat scheduler (R-S5a built every runtime with `canSchedule:false`
   * and started only the default's). Boot order is unchanged — the Router is created before
   * this runs, so the R-S5a scheduler-recovery race guard (recovery invoking
   * `runScheduledJob → handleScheduledJob → requireRouter()` before the router exists) still
   * holds for every profile. No-manager (test-double) mode starts just the attached runtime.
   */
  private async initializeScheduler(): Promise<void> {
    if (!this.config.heartbeat.enabled || !this.channel) return;
    const runtimes = this.manager ? this.manager.all() : (this.runtime ? [this.runtime] : []);
    for (const runtime of runtimes) {
      if (!runtime.agentLoop || !runtime.sessions) continue;
      if (!runtime.scheduler) {
        await runtime.initializeScheduler({
          schedulerPaths: this.schedulerPathsFor(runtime.profileId),
          runScheduledJob: (job) => this.handleScheduledJob(job, true),
        });
      }
      if (runtime.scheduler) {
        const startupChatId = await this.resolveStartupPolicyChatIdFor(runtime);
        if (startupChatId) await this.reconcileHeartbeatPolicies(startupChatId);
        await syncHeartbeatMarkdown(runtime.workspace, await runtime.scheduler.listJobs());
      }
    }
  }

  /**
   * RR-STRUCT R-S5b: scheduler paths per OWNING profile. The default (or legacy no-registry
   * mode) goes through the `hasBeenMigrated`-gated `resolveSchedulerPaths` exactly as before;
   * a NON-DEFAULT profile resolves DIRECTLY from the registry — never through that gate
   * (preserves the R-S5a invariant its spy test enforces: `resolveSchedulerPaths` is only
   * ever called with the default profileId).
   */
  private schedulerPathsFor(profileId: ProfileId): { storePath: string; auditLogPath: string } {
    const defaultProfileId = (this.config.profiles?.defaultProfileId ?? 'default') as ProfileId;
    if (profileId === defaultProfileId || !this.profileRegistry) {
      return this.resolveSchedulerPaths(profileId);
    }
    return {
      storePath: this.profileRegistry.profileSchedulerStore(profileId),
      auditLogPath: this.profileRegistry.profileAuditLog(profileId),
    };
  }

  private async handleScheduledJob(job: HeartbeatJob, invokedByScheduler = false): Promise<void> {
    if (this.stopping) return;
    const router = this.requireRouter();
    const profileId = router.resolveProfileForChat(job.chatId);
    if (profileId === null) {
      console.warn(`[gateway] Skipping heartbeat job ${job.id}: chat is not available in this runtime.`);
      return;
    }
    // RR-STRUCT R-S5b: the RR-4 `!isDefaultProfile` skip is RETIRED — the job dispatches to
    // the OWNING profile's runtime (its sessions/scheduler/coordinator), so outcomes,
    // delivery-policy reads, and failure records all land in that profile's stores.
    // Egress stays the daemon-singleton channel addressed by `job.chatId` (unchanged).
    const runtime = await this.resolveRuntimeForProfile(profileId);
    if (!runtime) {
      console.warn(`[gateway] Skipping heartbeat job ${job.id}: owning profile runtime is degraded.`);
      return;
    }
    const sessions = runtime.sessions;
    const scheduler = runtime.scheduler;
    const coordinator = runtime.turnCoordinator;
    if (!sessions || !coordinator) return;
    const decision = decideHeartbeatDelivery(job, {
      now: new Date(Date.now()),
      quietHours: this.config.heartbeat.policy.quietHours,
      lastChatActivityAt: sessions.getLastActiveAt(job.chatId),
      skipIfChatActiveWithinMinutes: this.config.heartbeat.policy.skipIfChatActiveWithinMinutes,
    });
    if (decision.action === 'skip') {
      await scheduler?.recordOutcome(job.id, decision.reason);
      return;
    }

    const input = [
      '[Heartbeat Trigger]',
      `Job id: ${job.id}`,
      `Job title: ${job.title}`,
      `Prompt: ${job.prompt}`,
    ].join('\n');

    try {
      // RR-STRUCT R-S3b (C-39 for heartbeats): thread the per-occurrence turnId so a
      // `ledger_record` inside this turn gets a deterministic idempotency key — a
      // scheduler RETRY of this occurrence dedupes instead of double-writing.
      const turnId = heartbeatTurnId(job);
      const result = await coordinator.runHeartbeat({
        chatId: job.chatId,
        input,
        turnId,
        egress: (text) => this.channel!.send(job.chatId, { text }),
        afterDelivery: async (agentResult) => {
          await scheduler?.recordOutcome(job.id, agentResult.text === HEARTBEAT_NOOP ? 'noop' : 'sent');
          await this.reconcileAfterScheduledDelivery(job.chatId);
        },
      });
      if (result.status === 'preempted') {
        try {
          await scheduler?.recordOutcome(job.id, 'skipped-recent-activity');
        } catch (recordError) {
          console.warn('[gateway] Failed to record preempted heartbeat skip:', summarizeErrorForLog(recordError));
        }
      }
    } catch (error) {
      if (error instanceof HeartbeatQueueFullError || error instanceof TurnQueueFullError) {
        console.warn(`[gateway] Heartbeat queue full for job ${job.id}; scheduler will retry.`);
        if (scheduler) {
          try {
            await scheduler.recordFailure(job.id, 'heartbeat queue full');
          } catch (recordError) {
            console.warn(
              `[gateway] Failed to record queue-full for job ${job.id}:`,
              summarizeErrorForLog(recordError),
            );
          }
        }
        return;
      }

      if (!invokedByScheduler && scheduler) {
        try {
          await scheduler.recordFailure(job.id, summarizeErrorForLog(error));
        } catch (recordError) {
          console.warn(
            `[gateway] Failed to record heartbeat failure for job ${job.id}:`,
            summarizeErrorForLog(recordError),
          );
        }
      }
      throw error;
    }
  }

  private async reconcileAfterScheduledDelivery(chatId: string): Promise<void> {
    try {
      await this.reconcileHeartbeatPolicies(chatId);
    } catch (error) {
      console.warn('[gateway] Post-delivery heartbeat reconciliation failed:', summarizeErrorForLog(error));
    }
  }

  /**
   * RR-STRUCT R-S5b: reconcile runs against the runtime OWNING `chatId` — its scheduler +
   * workspace — never the ambient default. A non-default chat's reconcile writes ONLY that
   * profile's `HEARTBEATS.md` + scheduler store (the pre-R-S5b early-return for non-default
   * chats is retired along with the refusal).
   */
  private async reconcileHeartbeatPolicies(chatId: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    // Sync-first: every already-built profile (boot eager-build, the overwhelming common case)
    // resolves with ZERO async hops, preserving the exact pre-R-S5b microtask timing the
    // debounce path is pinned to. The async fallback on-demand builds a profile paired after
    // boot that was never built (lazy serving).
    const runtime = this.runtimeForChatSync(chatId) ?? await this.runtimeForChat(chatId);
    if (!runtime?.scheduler) {
      return;
    }

    const desired = await buildDesiredHeartbeatJobs({
      workspacePath: runtime.workspace,
      chatId,
      timezone: this.config.heartbeat.timezone,
      policy: this.config.heartbeat.policy,
    });
    await reconcilePolicyJobs(runtime.scheduler, desired);
    await syncHeartbeatMarkdown(runtime.workspace, await runtime.scheduler.listJobs());
  }

  private async debouncedReconcile(chatId: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    // Synchronous resolve (no async hop): the debounce timer must be scheduled synchronously
    // so the window's timer semantics hold exactly as pre-R-S5b (fake-timer-pinned).
    const runtime = this.runtimeForChatSync(chatId);
    if (!runtime?.scheduler) {
      return;
    }

    const existing = this.reconcileTimers.get(chatId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(chatId);
      this.launchBackgroundReconcile(chatId);
    }, 30_000);
    timer.unref();
    this.reconcileTimers.set(chatId, timer);
  }

  /**
   * Kept for the single-runtime/test-double surface (F11 test calls this directly): resolves
   * the startup-policy chat for the DEFAULT (attached) runtime, exactly as before.
   */
  private async resolveStartupPolicyChatId(): Promise<string | undefined> {
    return this.resolveStartupPolicyChatIdFor(this.runtime);
  }

  /**
   * RR-STRUCT R-S5b: startup-policy resolution SCOPED to one profile's runtime — its most
   * recent session chat or scheduler job belonging to THAT profile (an unpaired/stale chat
   * belongs to the default only, preserving the F11 no-auto-pair-at-boot invariant for every
   * profile: this method only READS the registry, never pairs).
   */
  private async resolveStartupPolicyChatIdFor(runtime: ProfileRuntime | undefined): Promise<string | undefined> {
    if (!runtime) return undefined;
    const sessionChatId = runtime.sessions?.getMostRecentChatId();
    if (sessionChatId && this.chatBelongsToProfile(sessionChatId, runtime.profileId)) {
      return sessionChatId;
    }

    if (!runtime.scheduler) return undefined;
    const jobs = await runtime.scheduler.listJobs();
    return jobs.find((job) => job.chatId !== '__startup__' && this.chatBelongsToProfile(job.chatId, runtime.profileId))?.chatId;
  }

  private launchBackgroundReconcile(chatId: string): void {
    if (this.stopping) return;
    // Track the background op on the OWNING runtime so each profile's shutdown drain accounts
    // for its own reconciles (falls back to the default-tracked op if unresolvable). The
    // reconcile itself (`reconcileHeartbeatPolicies`) re-resolves async — this stays sync so
    // the timer callback's fire-and-track semantics hold under fake timers.
    const runtime = this.runtimeForChatSync(chatId) ?? this.runtime;
    if (!runtime) return;
    runtime.trackBackgroundOperation('heartbeat reconciliation', () => this.reconcileHeartbeatPolicies(chatId));
  }

  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.runtime) {
      return this.runtime.trackOperation(operation);
    }
    return Promise.resolve().then(operation);
  }

  private trackBackgroundOperation(label: string, operation: () => Promise<void>): void {
    if (this.stopping) return;
    this.runtime?.trackBackgroundOperation(label, operation);
  }

  private async drainBackgroundOperations(): Promise<void> {
    await this.runtime?.drainBackgroundOperations();
  }

  private bootstrapWorkspace(workspacePath: string): void {
    try {
      ensureWorkspaceBootstrap(workspacePath, {
        preserveExisting: true,
        log: (message) => console.log(`[gateway] ${message}`),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Workspace bootstrap failed: ${message}`);
    }
  }

  private tryCreateProfileRegistry(baseDir: string): ProfileRegistry | undefined {
    try {
      return new ProfileRegistry(baseDir);
    } catch (error) {
      console.error(
        '[gateway] Failed to initialize ProfileRegistry; continuing without profile-scoped storage:',
        summarizeErrorForLog(error),
      );
      return undefined;
    }
  }

  private migrateLegacySessionsBeforeProfileSeal(
    registry: ProfileRegistry,
    profileId: ProfileId,
    legacyWorkspace: string,
  ): boolean {
    const legacySessionsPath = path.join(path.dirname(legacyWorkspace), 'sessions');
    try {
      if (!fs.existsSync(legacySessionsPath)) return true;
      const legacyFiles = fs.readdirSync(legacySessionsPath)
        .filter((file) => file.startsWith('active-') && file.endsWith('.jsonl'));
      if (legacyFiles.length === 0) return true;

      const migration = new SessionManager({
        sessionsPath: registry.profileSessions(profileId),
        legacySessionsPath,
        perChatArchive: true,
        compaction: this.config.sessions.compaction,
      });
      if (!migration.didCompleteLegacyMigration) {
        console.warn('[gateway] Legacy global session migration did not complete; profile sentinel remains unsealed.');
        return false;
      }
      return true;
    } catch (error) {
      console.error('[gateway] Legacy global session migration failed; profile sentinel remains unsealed:', summarizeErrorForLog(error));
      return false;
    }
  }

  private migrateAndResolveWorkspace(
    registry: ProfileRegistry,
    profileId: ProfileId,
    legacyWorkspace: string,
  ): string {
    try {
      if (registry.hasBeenMigrated(profileId, legacyWorkspace)) {
        if (!this.migrateLegacySessionsBeforeProfileSeal(registry, profileId, legacyWorkspace)) {
          return legacyWorkspace;
        }
        const profileWorkspace = registry.profileWorkspace(profileId);
        console.log(`[gateway] Profile "${profileId}" already migrated; using ${profileWorkspace}`);
        return profileWorkspace;
      }

      if (!this.migrateLegacySessionsBeforeProfileSeal(registry, profileId, legacyWorkspace)) {
        return legacyWorkspace;
      }

      const result = registry.migrateLegacyWorkspace(legacyWorkspace);
      console.log(
        `[gateway] Legacy workspace migration: migrated=${result.migrated} skipped=${result.skipped} errors=${result.errors.length}`,
      );
      if (result.errors.length > 0) {
        console.warn(`[gateway] Migration encountered ${result.errors.length} error(s); details withheld from logs.`);
      }

      if (registry.hasBeenMigrated(profileId, legacyWorkspace)) {
        const profileWorkspace = registry.profileWorkspace(profileId);
        console.log(`[gateway] Using profile-scoped workspace: ${profileWorkspace}`);
        return profileWorkspace;
      }

      console.warn(
        `[gateway] Migration did not complete (no sentinel written); falling back to legacy workspace: ${legacyWorkspace}`,
      );
      return legacyWorkspace;
    } catch (error) {
      console.error(
        '[gateway] Profile migration failed unexpectedly; falling back to legacy workspace:',
        summarizeErrorForLog(error),
      );
      return legacyWorkspace;
    }
  }

  /**
   * RR-STRUCT R-S5a (mini-plan v3 §3.8 A-F04 — SAFETY-CRITICAL): the `buildRuntimeFor` injected
   * into `ProfileRuntimeManager`. Branches by profileId:
   *  - the DEFAULT profile (or ANY profile when there is no ProfileRegistry — legacy no-registry
   *    mode, A-F11) resolves paths via the EXACT SAME migration path as pre-R-S5a
   *    (`migrateAndResolveWorkspace` / `resolveSchedulerPaths`) — unchanged.
   *  - any NON-DEFAULT profile NEVER calls `migrateAndResolveWorkspace` or
   *    `migrateLegacySessionsBeforeProfileSeal` — it has no legacy data, and running either
   *    against it would leak the default user's legacy workspace/sessions into it (the design
   *    review reproduced exactly this — `505/exec/reviews/rr-struct-design-review-isolation.md`
   *    F-04). Instead every path is resolved DIRECTLY from the registry
   *    (`profileSearchDb`/`profileSessions`/`profileSchedulerStore`/`profileAuditLog`, no
   *    `hasBeenMigrated` gate, no `legacySessionsPath`) and the workspace is bootstrapped CLEAN —
   *    generic template files only (`ensureWorkspaceBootstrap`, the same primitive
   *    `bootstrapWorkspace()` uses for the legacy workspace — ships no PHI, just static repo
   *    assets), never a copy of the legacy/default content.
   */
  private async buildRuntimeFor(profileId: ProfileId): Promise<ProfileRuntime> {
    const { config } = this;
    const defaultProfileId = (config.profiles?.defaultProfileId ?? 'default') as ProfileId;
    const registry = this.profileRegistry;
    const isDefault = profileId === defaultProfileId;

    let workspace: string;
    let dbPath: string;
    let sessionsPath: string | undefined;
    let schedulerPaths: { storePath: string; auditLogPath: string };

    if (isDefault || !registry) {
      const legacyWorkspace = config.memory.workspace;
      workspace = registry
        ? this.migrateAndResolveWorkspace(registry, profileId, legacyWorkspace)
        : legacyWorkspace;
      this.resolvedMemoryWorkspace = workspace;
      const usingProfileWorkspace = workspace !== legacyWorkspace;

      dbPath = usingProfileWorkspace && registry
        ? registry.profileSearchDb(profileId)
        : path.join(legacyWorkspace, '..', 'search.db');

      sessionsPath = registry
        ? (usingProfileWorkspace
          ? registry.profileSessions(profileId)
          : path.join(path.dirname(legacyWorkspace), 'sessions'))
        : undefined;

      schedulerPaths = this.resolveSchedulerPaths(profileId);
    } else {
      workspace = registry.profileWorkspace(profileId);
      try {
        ensureWorkspaceBootstrap(workspace, {
          preserveExisting: true,
          log: (message) => console.log(`[gateway] [profile:${profileId}] ${message}`),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Workspace bootstrap failed for profile "${profileId}": ${message}`);
      }
      dbPath = registry.profileSearchDb(profileId);
      sessionsPath = registry.profileSessions(profileId);
      schedulerPaths = {
        storePath: registry.profileSchedulerStore(profileId),
        auditLogPath: registry.profileAuditLog(profileId),
      };
    }

    return ProfileRuntime.create({
      profileId,
      workspace,
      dbPath,
      sessionsPath,
      schedulerPaths,
      config,
      mainProvider: this.mainProvider!,
      semaphore: this.semaphore!,
      // Scheduler recovery can invoke the callback before ProfileRuntime.create returns. Delay
      // scheduler construction until Gateway explicitly initializes it (initializeScheduler,
      // default-profile-only this slice — see its own doc comment).
      canSchedule: false,
      runScheduledJob: (job) => this.handleScheduledJob(job, true),
      reconcile: (chatId) => this.debouncedReconcile(chatId),
      sideEffectLookup: (entity) => this.lookupSideEffects(this.sideEffectProvider ?? this.mainProvider!, entity),
    });
  }

  /** Every profile the manager should eager-build at boot: the default (always) plus every
   *  profile with >=1 paired chat (mini-plan v3 §3.8/§5 R-S5a). A profile that exists in the
   *  registry but has never been paired to a chat has nothing to serve yet and is skipped. */
  private pairedProfileIds(defaultProfileId: ProfileId): ProfileId[] {
    if (!this.profileRegistry) return [defaultProfileId];
    const paired = this.profileRegistry.getAllProfiles()
      .filter((profile) => profile.chatIds.length > 0)
      .map((profile) => profile.profileId);
    return [...new Set([defaultProfileId, ...paired])];
  }

  private async runBootHealthchecks(): Promise<void> {
    const controller = new AbortController();
    const readiness = checkSystemReadiness(this.config, {
      allowNetworkChecks: true,
      overallTimeoutMs: BOOT_HEALTHCHECK_BUDGET_MS,
      signal: controller.signal,
    });
    const completion = this.mainProvider && typeof probeChatCompletion === 'function'
      ? probeChatCompletion(this.mainProvider, {
        label: 'main provider',
        timeoutMs: BOOT_HEALTHCHECK_BUDGET_MS,
        signal: controller.signal,
      })
      : Promise.resolve(undefined);
    const allChecks = Promise.all([readiness, completion]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(null);
      }, BOOT_HEALTHCHECK_BUDGET_MS);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([allChecks, deadline]);
      if (result === null) {
        this.bootHealth = pendingBootHealth();
        console.warn('[gateway] Boot healthcheck exceeded startup budget; continuing in degraded health-check-pending state');
        void allChecks
          .then(([healthResults, completionResult]) => {
            if (this.stopping) return;
            this.finishBootHealthchecks(healthResults, completionResult);
          })
          .catch((error) => {
            console.warn('[gateway] Deferred boot healthcheck failed:', summarizeErrorForLog(error));
          });
        return;
      }
      this.finishBootHealthchecks(result[0], result[1]);
    } catch (error) {
      console.warn('[gateway] Boot healthcheck failed:', summarizeErrorForLog(error));
    } finally {
      if (!timedOut) controller.abort();
      if (timer) clearTimeout(timer);
    }
  }

  private finishBootHealthchecks(
    healthResults: { providers: ReadinessResult[]; telegram: ReadinessResult },
    completion?: ReadinessResult,
  ): void {
    this.mergeMainCompletionResult(healthResults, completion);
    this.bootHealth = healthResults;
    const allReady = healthResults.providers.every((p) => p.ready) && healthResults.telegram.ready;
    if (!allReady) {
      console.warn('[gateway] Boot healthcheck: NOT ALL READY');
      for (const r of [...healthResults.providers, healthResults.telegram]) {
        if (!r.ready) {
          console.warn(`  ${r.label}: ${r.details.join(', ')}`);
          if (r.actionHint) {
            console.warn(`  → ${r.actionHint}`);
          }
        }
      }
    } else {
      console.log('[gateway] Boot healthcheck: all systems ready');
    }
  }

  private mergeMainCompletionResult(
    healthResults: { providers: ReadinessResult[]; telegram: ReadinessResult },
    completion?: ReadinessResult,
  ): void {
    const idx = healthResults.providers.findIndex((p) => p.label === 'main provider');
    if (idx < 0 || !completion || !healthResults.providers[idx].ready) return;
    const base = healthResults.providers[idx];
    if (!completion.ready) {
      healthResults.providers[idx] = {
        ...base,
        ready: false,
        status: 'fail',
        details: [...base.details, ...completion.details],
        reasonCode: completion.reasonCode,
        actionHint: completion.actionHint,
      };
    } else if (completion.status === 'warn') {
      healthResults.providers[idx] = {
        ...base,
        status: base.status === 'ok' ? 'warn' : base.status,
        details: [...base.details, ...completion.details],
        warnings: [...base.warnings, ...completion.warnings],
        reasonCode: base.reasonCode ?? completion.reasonCode,
        actionHint: base.actionHint ?? completion.actionHint,
      };
    } else {
      healthResults.providers[idx] = { ...base, details: [...base.details, ...completion.details] };
    }
  }

  private runSecurityChecks(): void {
    this.securityWarnings = [];
    try {
      const bindResult = checkProviderBindAddresses(this.config);
      for (const w of bindResult.warnings) {
        console.warn(`[security] ${w}`);
        this.securityWarnings.push(w);
      }
    } catch (error) {
      console.warn('[security] Bind check failed:', summarizeErrorForLog(error));
    }
    try {
      const workspace = this.getEffectiveWorkspace();
      const permsResult = verifyWorkspacePermissions(workspace);
      for (const w of permsResult.warnings) {
        console.warn(`[security] ${w}`);
        this.securityWarnings.push(w);
      }
    } catch (error) {
      console.warn('[security] Perms check failed:', summarizeErrorForLog(error));
    }
  }

  private buildBootStatusText(health?: { providers: ReadinessResult[]; telegram: ReadinessResult }): string {
    const h = health ?? this.bootHealth;
    if (!h) {
      return 'System health check not yet complete.';
    }
    const pending = [...h.providers, h.telegram].some((result) => result.reasonCode === 'healthcheck-timeout');
    const promptMode = this.runtime?.promptMode ?? 'boot-cached';
    const lines = [
      `System Health${pending ? ' (health-check-pending)' : ''}:`,
      ...h.providers.map((p) => `  ${p.label}: ${readinessLabel(p)}`),
      `  telegram: ${readinessLabel(h.telegram)}`,
      `  prompt: ${promptMode}${promptMode === 'boot-cached' ? ' (recall off — degraded)' : ''}`,
    ];
    if (this.securityWarnings.length > 0) {
      lines.push('', `Security warnings: ${this.securityWarnings.length} (details in local logs)`);
    }
    lines.push('', 'See `npm run cli -- status` for details.');
    return lines.join('\n');
  }

  private getEffectiveWorkspace(): string {
    return this.runtime?.workspace || this.resolvedMemoryWorkspace || this.config.memory?.workspace || '';
  }

  private mediaStagingDir(): string {
    return path.join(os.homedir(), '.redacted', '.staging', 'media');
  }

  private createRouter(): GatewayMessageRouter {
    return new GatewayMessageRouter({
      config: this.config,
      runtime: this.runtime,
      profileRegistry: this.profileRegistry,
      stagingDir: this.mediaStagingDir(),
      stagingBaseDir: os.homedir(),
      buildBootStatusText: () => this.buildBootStatusText(),
      // RR-STRUCT R-S5b (mini-plan v3 §3.2): the Router dispatches every turn to the runtime
      // OWNING the resolved profile. Manager-backed in production; when no manager exists
      // (the `attachGatewayTestRuntime` test-double seam, which never builds one) every
      // profileId resolves to the single attached runtime — one resolver-based code path,
      // both worlds working. Never rejects: a degraded profile yields `undefined` and the
      // Router emits the canned degraded reply instead of crashing.
      resolveRuntime: (profileId) => this.resolveRuntimeForProfile(profileId),
    });
  }

  /**
   * RR-STRUCT R-S5b: the single per-profile runtime accessor every dispatch path funnels
   * through (message routing via the Router's resolver, scheduled jobs, reconciles).
   * `manager.get` is a memoized map read (single-flight); a persistently-broken profile
   * rejects per call (rejection-evict + retry, Finding-7a) and degrades to `undefined`
   * with a sanitized log — never a throw to the daemon.
   */
  private async resolveRuntimeForProfile(profileId: ProfileId): Promise<ProfileRuntime | undefined> {
    try {
      if (this.manager) return await this.manager.get(profileId);
      return this.runtime;
    } catch (error) {
      console.warn(
        `[gateway] Profile "${profileId}" runtime unavailable; degrading work for that profile:`,
        summarizeErrorForLog(error),
      );
      return undefined;
    }
  }

  /** The runtime OWNING `chatId` (registry lookup only — never auto-pairs; an unpaired chat
   *  falls back to the default exactly as the pre-R-S5b reconcile did). May on-demand BUILD a
   *  not-yet-built profile via the manager (single-flight, memoized) — for foreground paths
   *  (turns, jobs, startup) where the caller already awaits. */
  private async runtimeForChat(chatId: string): Promise<ProfileRuntime | undefined> {
    const resolved = this.profileRegistry?.getProfileForChat(chatId);
    const profileId = resolved?.profileId ?? (this.config.profiles?.defaultProfileId ?? 'default') as ProfileId;
    return this.resolveRuntimeForProfile(profileId);
  }

  /** Synchronous twin of `runtimeForChat` for the timer-driven reconcile path (see
   *  `ProfileRuntimeManager.getIfBuilt`): never builds, never awaits — `undefined` means
   *  "nothing to reconcile right now". */
  private runtimeForChatSync(chatId: string): ProfileRuntime | undefined {
    const resolved = this.profileRegistry?.getProfileForChat(chatId);
    const profileId = resolved?.profileId ?? (this.config.profiles?.defaultProfileId ?? 'default') as ProfileId;
    if (this.manager) return this.manager.getIfBuilt(profileId);
    return this.runtime;
  }

  private chatBelongsToProfile(chatId: string, profileId: ProfileId): boolean {
    const resolved = this.profileRegistry?.getProfileForChat(chatId);
    if (!resolved) return profileId === (this.config.profiles?.defaultProfileId ?? 'default');
    return resolved.profileId === profileId;
  }

  private requireRuntimeForAccess(): ProfileRuntime {
    if (!this.runtime) throw new Error('Gateway runtime must be attached or started before field access');
    return this.runtime;
  }

  private requireRouter(): GatewayMessageRouter {
    if (!this.router) this.router = this.createRouter();
    return this.router;
  }

  private resolveSchedulerPaths(profileId: ProfileId): { storePath: string; auditLogPath: string } {
    const legacy = { storePath: this.config.heartbeat.storePath, auditLogPath: this.config.heartbeat.audit.path };
    if (!this.profileRegistry) {
      return legacy;
    }
    try {
      if (!this.profileRegistry.hasBeenMigrated(profileId, this.config.memory.workspace)) {
        console.warn('[gateway] Profile migration incomplete; using legacy heartbeat/audit paths.');
        return legacy;
      }
      const storePath = this.profileRegistry.profileSchedulerStore(profileId);
      const auditLogPath = this.profileRegistry.profileAuditLog(profileId);
      console.log(`[gateway] Using profile-scoped scheduler paths: store=${storePath} audit=${auditLogPath}`);
      return { storePath, auditLogPath };
    } catch (error) {
      console.error(
        '[gateway] Failed to resolve profile-scoped scheduler paths; falling back to legacy paths:',
        summarizeErrorForLog(error),
      );
      return legacy;
    }
  }
}
