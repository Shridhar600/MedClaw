import * as fs from 'fs';
import * as path from 'path';
import type { EffectiveConfig } from '../config/types';
import { asProfileId, resolveOwnerPaths } from '../profiles';
import type { OwnerAdmissionService, OwnerPaths, ProfileId } from '../profiles';
import type { AdmittedMessage, Channel, IncomingMessage } from '../channels';
import { TelegramChannel } from '../channels';
import { LLMSemaphore, HeartbeatQueueFullError } from '../tools/semaphore';
import { createProvider, type ProviderFactory } from '../providers/factory';
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
import { GatewayMessageRouter, transportIdentityOf } from './router';
import { sweepStagedMedia, type MediaSweepResult } from './media-sweep';
import { FsMediaStager } from '../runtime';
import type { MediaSourcePort } from '../ports/media-source';
import type { DiagnosticEvent, DiagnosticSink } from '../ports/diagnostics';
import { SILENT_DIAGNOSTIC_SINK, guardedDiagnosticSink } from '../ports/diagnostics';
import type { Clock } from '../ports/clock';
import { systemClock } from '../ports/defaults';
import { TurnQueueFullError, heartbeatTurnId } from './turn-coordinator';

/** Canned, non-clinical explanations for a refused attachment. Never leaks a reason detail. */
const MEDIA_REFUSAL_TEXT: Record<string, string> = {
  unsupported: 'That attachment type cannot be accepted.',
  'advertised-too-large': 'That file is larger than the 10 MB limit.',
  'too-large': 'That file is larger than the 10 MB limit.',
  timeout: 'That upload took too long and was cancelled. Please try again.',
  'queue-full': 'Too many uploads are already being processed. Please try again in a moment.',
  aborted: 'That upload was cancelled.',
  'source-failed': 'Failed to retrieve that attachment. Please try uploading it again.',
};

export interface GatewayAdmissionDeps {
  /** The owner's enrollment authority. Required: a Gateway without it would serve every chat as the owner. */
  admission: OwnerAdmissionService;
  /** The owner identity `admission` is configured for. REQUIRED; never inferred, never defaulted. */
  ownerId: ProfileId;
  /** How providers are built for this daemon. Defaults to the real factory. */
  createProvider?: ProviderFactory;
  /**
   * How attached media bytes are retrieved. When absent, media is refused rather than silently
   * dropped: a transport that cannot retrieve bytes must not appear to succeed.
   */
  mediaSource?: MediaSourcePort;
  /** The closed diagnostic contract for admission, pairing, media intake and start/stop. Silent by default. */
  diagnostics?: DiagnosticSink;
  /** Optional: defaults to the system clock. Injected in tests so durations are real measurements. */
  clock?: Clock;
}

const SHUTDOWN_RESPONSE = 'The health assistant is shutting down. Please try again in a moment.';
const BOOT_HEALTHCHECK_BUDGET_MS = 3_000;

/**
 * Thrown when a scheduled delivery is suppressed because the destination chat no longer belongs to
 * the owning profile. Not an operational error: it must never enter the retry/dead-letter path or be
 * recorded as sent.
 */
class HeartbeatDestinationSuppressedError extends Error {
  constructor() {
    super('heartbeat destination is no longer owned by the dispatching profile');
    this.name = 'HeartbeatDestinationSuppressedError';
  }
}

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

/**
 * Thrown when `serveOwner()` refuses to replace a runtime generation that still has unsettled work.
 * Carries no owner, chat or path data.
 */
class PreviousWorkUnsettledError extends Error {}
class AdmissionRefusedError extends Error {}

export class Gateway {
  private config: EffectiveConfig;
  private channel?: Channel;
  private resolvedMemoryWorkspace?: string;
  private bootHealth?: { providers: ReadinessResult[]; telegram: ReadinessResult };
  private mainProvider?: LLMProvider;
  /** Medical-provider fallback for medication side-effect lookups, shared by every profile's runtime. */
  private sideEffectProvider?: LLMProvider;
  private securityWarnings: string[] = [];
  private reconcileTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private semaphore?: LLMSemaphore;
  private stopping = false;
  private stopped = false;
  /** Inbound turns that have started and not settled. Drives `getShutdownDisposition()`. */
  private inboundTurnsInFlight = 0;
  private stopPromise?: Promise<void>;
  private runtime?: ProfileRuntime;
  /** Owns one ProfileRuntime per paired profile. `this.runtime` is the default profile's runtime. */
  private manager?: ProfileRuntimeManager;
  private router?: GatewayMessageRouter;
  /** Sole authority for who may reach a clinical runtime; its boot answer decides whether one is built. */
  private admission: OwnerAdmissionService;
  /**
   * Set when the owner record is not yet bound. While true the daemon serves pairing and canned
   * emergency guidance only: no provider, no workspace bootstrap, no runtime, no index, no
   * scheduler. This is what keeps "unpaired" from quietly meaning "serving on a default identity".
   */
  private unpairedOnly = false;
  /** The owner identity admission is configured for, used as the dispatch target when admitted. */
  private admissionOwnerId: ProfileId;
  /** The one derivation of this owner's resources, memoised from the validated config. */
  private ownerPathsCache?: OwnerPaths;
  private readonly buildProvider: ProviderFactory;
  private readonly mediaSource?: MediaSourcePort;
  private readonly sink: DiagnosticSink;
  /** Injected so a start/stop duration is measured, not guessed. */
  private readonly clock: Clock;
  /**
   * Abort signal for in-flight media intake. `stop()` aborts it permanently, so `start()` re-arms it
   * with a fresh controller.
   */
  private mediaIntake = new AbortController();
  /** In-flight unpaired -> bound promotion, so concurrent messages cannot both build a runtime. */
  private pairingTransition?: Promise<void>;
  /** An attempt is not successful completion. Never retry during promotion or live intake. */
  private bootSweepAttempted = false;
  private bootSweepResult?: MediaSweepResult;
  /**
   * One media stager per Gateway. Its active/waiting counters implement the intake concurrency bound,
   * so it must NOT be rebuilt per message — see `mediaStager()`.
   */
  private mediaStagerCache?: FsMediaStager;

  constructor(config: EffectiveConfig, deps: GatewayAdmissionDeps) {
    this.config = config;
    this.admission = deps.admission;
    this.admissionOwnerId = deps.ownerId;
    this.buildProvider = deps.createProvider ?? createProvider;
    this.mediaSource = deps.mediaSource;
    this.sink = guardedDiagnosticSink(deps.diagnostics ?? SILENT_DIAGNOSTIC_SINK);
    this.clock = deps.clock ?? systemClock;
  }

  /** True when the daemon is serving pairing only, with no clinical runtime built. */
  get servesPairingOnly(): boolean {
    return this.unpairedOnly;
  }

  get runtimeInstance(): ProfileRuntime | undefined {
    return this.runtime;
  }

  /** Actual boot cleanup outcome, including bounded partial/unavailable disposition. */
  get stagingCleanupResult(): MediaSweepResult | undefined {
    return this.bootSweepResult ? { ...this.bootSweepResult } : undefined;
  }

  /** Test/diagnostic seam: the manager owning every built profile's runtime. */
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
    const startedAt = this.clock.now().getTime();
    try {
      await this.startServing();
    } catch (error) {
      // Report a replacement refusal as its own outcome, not as a build failure: nothing was built.
      if (error instanceof PreviousWorkUnsettledError) {
        this.sink.emit({
          stage: 'start-stop',
          operation: 'start',
          outcome: 'refused',
          reason: 'previous-work-unsettled',
          durationMs: this.elapsedSince(startedAt),
        });
      } else if (error instanceof AdmissionRefusedError) {
        this.emit({ stage: 'start-stop', operation: 'start', outcome: 'refused', reason: 'admission-refused', durationMs: this.elapsedSince(startedAt) });
      } else {
        this.sink.emit({
          stage: 'start-stop',
          operation: 'start',
          outcome: 'failed',
          reason: 'build-failed',
          durationMs: this.elapsedSince(startedAt),
        });
      }
      throw error;
    }
    this.sink.emit({ stage: 'start-stop', operation: 'start', outcome: 'started', durationMs: this.elapsedSince(startedAt) });
  }

  /** Emit helpers. The sink is guarded in the constructor, so no emit can throw into a boot. */
  private emit(event: DiagnosticEvent): void {
    this.sink.emit(event);
  }

  private elapsedSince(startedAt: number): number {
    const elapsed = this.clock.now().getTime() - startedAt;
    return elapsed > 0 ? elapsed : 0;
  }

  private async startServing(): Promise<void> {
    const { config } = this;
    this.stopping = false;
    this.stopped = false;

    console.log('[gateway] Starting Redacted...');

    // Admission comes first. A missing, corrupt or wrong-owner record must not boot into a serving
    // state, and an unpaired record must not build anything clinical: both are decided before any
    // provider, workspace, index or scheduler exists.
    // Re-arm intake for this run: an aborted signal cannot be reused.
    this.mediaIntake = new AbortController();

    const admissionState = this.admission.inspectInstallation();
    if (admissionState.kind === 'refused') {
      // start() owns the one terminal result. Admission has already emitted the precise reason.
      throw new AdmissionRefusedError(
        `Refusing to serve: the owner record is ${admissionState.reason}. `
        + 'Re-run setup on this computer, then start the daemon again.',
      );
    }
    // Staging sweep: boot only. It must not run during an unpaired -> bound promotion or while intake
    // is live, or it could delete a file the owner is mid-upload. It runs once, after admission has
    // confirmed the owner and before any intake is accepted.
    this.sweepOwnerStagingLane();

    if (admissionState.kind === 'unpaired') {
      this.unpairedOnly = true;
      await this.startUnpaired(config);
      return;
    }

    await this.serveOwner({ connectChannel: true, runHealthchecks: true });

    console.log('[gateway] Redacted is running.');
  }

  /** Attempt once before intake. Failure preserves authority and never triggers a promotion retry. */
  private sweepOwnerStagingLane(): void {
    if (this.bootSweepAttempted) return;
    this.bootSweepAttempted = true;
    const ownerStaging = this.mediaStagingDir();
    const result: MediaSweepResult = ownerStaging
      ? sweepStagedMedia(ownerStaging, this.ownerStagingBase())
      : { kind: 'unavailable', inspected: 0, removed: 0, reason: 'invalid-root' };
    this.bootSweepResult = result;
    if (result.kind !== 'complete') {
      console.warn(`[gateway] Media staging cleanup ${result.kind}: reason=${result.reason} inspected=${result.inspected} removed=${result.removed}`);
    }
  }

  /**
   * Whether replacing the installed runtime generation would hide work that can still touch owner
   * resources. Reads the same sources `stopResources()` drains and `getShutdownDisposition()`
   * reports, so it cannot disagree with the disposition root releases on.
   */
  private replacementWouldHideLiveWork(): boolean {
    // An unfinished stop means this Gateway is mid-teardown. Replacing the generation now would
    // redirect `stopResources()`'s drain at the NEW manager and strand the old one entirely.
    if (this.stopPromise) return true;
    // Draining awaits an unsettled construction with no budget of its own, so replacing now could block start() forever.
    if ((this.manager?.pendingBuildCount() ?? 0) > 0) return true;
    const runtimes = this.manager ? this.manager.all() : (this.runtime ? [this.runtime] : []);
    for (const runtime of runtimes) {
      if (runtime.getShutdownDisposition() === 'pending') return true;
    }
    return false;
  }

  /**
   * Refuse replacement without mutating anything: the old generation stays installed and drainable.
   * The message carries no owner, chat or path data.
   */
  private refuseRuntimeReplacement(): never {
    throw new PreviousWorkUnsettledError(
      'Refusing to serve: the previous runtime still has work in flight that can write to this '
      + 'installation, so ownership cannot be handed to a replacement. Wait for it to finish, then '
      + 'start the daemon again.',
    );
  }

  /**
   * Build everything only the bound owner may have: workspace, providers, runtime, router and
   * scheduler. Shared by boot and the unpaired -> bound promotion.
   */
  private async serveOwner(options: { connectChannel: boolean; runHealthchecks: boolean }): Promise<void> {
    const { config } = this;

    // Refuse to replace a generation that still has unsettled work. The drain below is bounded, so
    // overwriting `this.manager` proves nothing finished and would hide that work from
    // `getShutdownDisposition()`. Checked before anything is built so a refusal leaves no half-built
    // generation, and here because both boot and promotion pass through this method.
    if (this.replacementWouldHideLiveWork()) this.refuseRuntimeReplacement();

    // Resolved once so a config that names no valid owner refuses the boot before anything is built.
    const ownerPaths = this.ownerPaths();
    const profileId = ownerPaths.profileId;

    // Bootstrap workspace with template files on first run
    this.bootstrapWorkspace(config.memory.workspace);

    const mainProvider = this.buildProvider(config.providers.main);
    this.mainProvider = mainProvider;

    const semaphore = new LLMSemaphore();
    this.semaphore = semaphore;

    let sideEffectProvider: LLMProvider = mainProvider;
    try {
      sideEffectProvider = this.buildProvider(config.providers.medical);
    } catch (error) {
      console.warn('[gateway] Medical provider for side-effect lookup unavailable; using main:', summarizeErrorForLog(error));
    }
    this.sideEffectProvider = sideEffectProvider;

    // Channel. On the pairing transition the pairing-only channel is already constructed and
    // connected, so it is reused rather than replaced — replacing it would drop the very connection
    // that delivered the pairing code.
    if (!this.channel && config.channels.telegram.enabled) {
      const token = config.channels.telegram.botToken || process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        throw new Error('TELEGRAM_BOT_TOKEN not set. Set it in config or environment.');
      }
      // The channel emits media references only; it never downloads or writes files. Whether bytes are
      // fetched is decided by `admitAndStage`, and containment belongs to `FsMediaStager`.
      this.channel = new TelegramChannel(token);
      this.channel.onMessage((msg) => this.handleMessage(msg));
    }

    // The default profile is built first and directly, so a genuine failure propagates out of start()
    // after exactly one attempt. Other paired profiles are then built individually guarded, so a
    // broken secondary profile never aborts boot.
    // A promotion that fails after this point is re-entered by the next owner message, so any earlier
    // manager is drained first; `stopResources` only drains the current one.
    if (this.manager !== undefined) {
      try {
        await this.manager.drainAndCloseAll();
      } catch (error) {
        // A failure to drain the old runtime must not stop the new one from being built, or a retry
        // could never make progress. It is reported, not swallowed.
        console.warn('[gateway] Failed to drain the previous runtime before rebuilding:', summarizeErrorForLog(error));
      }
      // Second replacement check: the drain itself can leave a phase unsettled (for example a stalled
      // compaction or scheduler stop). Placed immediately before the overwrite it guards.
      if (this.replacementWouldHideLiveWork()) this.refuseRuntimeReplacement();
    }

    this.manager = new ProfileRuntimeManager((id) => this.buildRuntimeFor(id));
    this.runtime = await this.manager.get(profileId);
    await this.manager.buildAll(this.pairedProfileIds());

    this.router = this.createRouter();
    if (options.connectChannel && this.channel && typeof this.channel.connect === 'function') {
      await this.channel.connect();
    }

    // If stop() began during the build, do not start a scheduler that nothing would drain.
    if (this.stopping) {
      console.log('[gateway] Shutdown began while building the owner runtime; not starting the scheduler.');
      return;
    }

    await this.initializeScheduler();

    if (options.runHealthchecks) {
      await this.runBootHealthchecks();
      this.runSecurityChecks();
    }

    this.unpairedOnly = false;
  }

  /**
   * Nightly transcript sweep across every built profile. Returns the default profile's result; other
   * profiles are swept against their own data and individually guarded, so one failure never aborts
   * another.
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

  /**
   * Local-transport test seam, not a serving path. It presents a `local` transport identity (admission
   * refuses a message with none) and goes through `deliverMessage`, so it exercises the same admission
   * and promotion path as a real message. It takes no media; tests that need admitted media drive
   * `deliverMessage` directly.
   */
  async handleTestMessage(chatId: string, text: string, sourceMessageId?: string): Promise<string> {
    if (this.stopping) return SHUTDOWN_RESPONSE;
    const eventId = `local:${chatId}:${sourceMessageId ?? 'adhoc'}`;
    let reply = '';
    await this.deliverMessage(
      {
        chatId,
        userId: 'local',
        text,
        channel: 'local',
        chatType: 'private',
        eventId,
        ...(sourceMessageId ? { messageId: sourceMessageId } : {}),
      },
      async (response) => {
        reply = response;
      },
    );
    return reply;
  }

  /** The Telegram channel's inbound callback: a thin adapter over `deliverMessage` that supplies the channel's egress. */
  private async handleMessage(incoming: IncomingMessage): Promise<void> {
    try {
      await this.deliverMessage(incoming, (text) => this.channel!.send(incoming.chatId, { text }));
    } catch (error) {
      console.error('[gateway] Handler error:', summarizeErrorForLog(error));
    }
  }

  /**
   * The one inbound path every transport shares; a non-Telegram adapter calls it with its own egress.
   * Not an admission bypass: admission sees exactly the identity the transport supplied.
   */
  async deliverMessage(incoming: IncomingMessage, egress: (text: string) => Promise<void>): Promise<void> {
    if (this.stopping) return;
    // A daemon that booted unpaired has no runtime; if the owner has since paired, build one now,
    // before staging so the transition never races a retrieval it would then discard. The promotion
    // is tracked because it touches owner resources: untracked, shutdown could report `quiescent`
    // and release the installation lease while it is still writing.
    await this.trackInboundTurn(() => this.ensureOwnerServing(incoming));
    if (this.stopping) return;
    const admitted = await this.admitAndStage(incoming);
    if (!admitted) return;
    await this.trackInboundTurn(() => this.requireRouter().route(admitted, egress));
  }

  /**
   * Promote a pairing-only daemon to a serving one on the first admitted owner message, so the owner
   * does not have to restart the daemon after pairing. Single-flight: two messages arriving together
   * must not both build a runtime.
   */
  private async ensureOwnerServing(incoming: IncomingMessage): Promise<void> {
    if (!this.unpairedOnly || this.stopping) return;
    // Eligibility precedes claiming OR joining the flight. A stranger's no-op must never occupy
    // the slot that the owner's first narrative needs to construct its serving runtime.
    if (this.admission.inspect(transportIdentityOf(incoming)).kind !== 'owner') return;

    const transition = this.pairingTransition ??= (async () => {
      const startedAt = this.clock.now().getTime();
      try {
        console.log('[gateway] Owner paired. Building the owner runtime.');
        await this.serveOwner({ connectChannel: false, runHealthchecks: false });
        this.emit(this.unpairedOnly
          ? { stage: 'start-stop', operation: 'promotion', outcome: 'refused', reason: 'shutdown-in-progress', durationMs: this.elapsedSince(startedAt) }
          : { stage: 'start-stop', operation: 'promotion', outcome: 'started', durationMs: this.elapsedSince(startedAt) });
      } catch (error) {
        // A failed promotion must not take the daemon down, and must not leave `unpairedOnly`
        // cleared: the next owner message retries rather than silently serving nothing.
        console.error('[gateway] Could not start serving after pairing:', summarizeErrorForLog(error));
        this.emit(error instanceof PreviousWorkUnsettledError
          ? { stage: 'start-stop', operation: 'promotion', outcome: 'refused', reason: 'previous-work-unsettled', durationMs: this.elapsedSince(startedAt) }
          : { stage: 'start-stop', operation: 'promotion', outcome: 'failed', reason: 'build-failed', durationMs: this.elapsedSince(startedAt) });
      }
    })();

    try {
      await transition;
    } finally {
      // A settled waiter owns cleanup only for the flight it actually awaited.
      if (this.pairingTransition === transition) this.pairingTransition = undefined;
    }
  }

  /**
   * Apply the admission policy, then stage any media, then re-check authority before the turn begins.
   * A denied identity never causes a fetch, and authority is re-read after the slow retrieval so a
   * binding that changed mid-download cannot be raced into a clinical turn.
   */
  private async admitAndStage(incoming: IncomingMessage): Promise<AdmittedMessage | undefined> {
    // Admission always exists, so there is no "no authority" branch to fail closed in.
    const decision = this.admission.inspect(transportIdentityOf(incoming));
    const admitted: AdmittedMessage = { ...incoming };

    if (decision.kind !== 'owner') {
      // Not the owner: no media is fetched, staged or buffered. The message still goes to the Router,
      // which owns every refusal and pairing reply (including the owner's pairing code).
      if (incoming.media) admitted.mediaError = MEDIA_REFUSAL_TEXT.unsupported;
      return admitted;
    }

    if (!incoming.media) return admitted;

    const stager = this.mediaStager();
    if (!stager) {
      // No source bound: say the upload could not be taken rather than pretending it succeeded.
      admitted.mediaError = 'Attachments cannot be accepted by this installation right now.';
      return admitted;
    }

    const signal = this.mediaIntake.signal;
    const staged = await this.trackInboundTurn(() => stager.stage(incoming.media, signal));
    if (staged.kind === 'refused') {
      admitted.mediaError = MEDIA_REFUSAL_TEXT[staged.reason];
      return admitted;
    }

    // Re-check authority AFTER the retrieval. A binding revoked mid-download must not adopt a file.
    const recheck = this.admission.inspect(transportIdentityOf(incoming));
    if (recheck.kind !== 'owner') {
      this.deleteStagedFile(staged.absolutePath);
      return undefined;
    }

    admitted.mediaPath = staged.absolutePath;
    return admitted;
  }

  /** Remove one staged file this operation created. Scoped: it never sweeps a directory. */
  private deleteStagedFile(target: string): void {
    try {
      fs.unlinkSync(target);
    } catch {
      // best effort: a leftover staged file is swept on the next owned boot
    }
  }

  /**
   * Run one inbound turn while it is visible to the shutdown disposition. A turn that has started and
   * not settled may still read or write owner resources, so it is counted.
   */
  private async trackInboundTurn<T>(operation: () => Promise<T>): Promise<T> {
    this.inboundTurnsInFlight += 1;
    try {
      return await this.trackOperation(operation);
    } finally {
      this.inboundTurnsInFlight -= 1;
    }
  }

  /**
   * Whether anything that can still touch owner resources has settled. `pending` covers in-flight
   * construction, inbound turns, an unfinished drain, and any runtime continuation that has not really
   * settled (including a drain phase abandoned at the shared budget). Only `quiescent` authorises
   * releasing the installation's resource ownership; a stop that returns after a timeout is not quiescence.
   */
  getShutdownDisposition(): 'quiescent' | 'pending' {
    if (this.stopPromise) return 'pending';
    if (this.inboundTurnsInFlight > 0) return 'pending';
    if (this.manager?.pendingBuildCount() ?? 0 > 0) return 'pending';
    // A runtime that closed its stores while a drain phase was abandoned still has a continuation that
    // can write owner files. Reads the same sources `stopResources()` drains.
    for (const runtime of this.manager ? this.manager.all() : (this.runtime ? [this.runtime] : [])) {
      if (runtime.getShutdownDisposition() === 'pending') return 'pending';
    }
    return 'quiescent';
  }

  /**
   * Counters behind the disposition, for local reporting and tests. `runtimes` counts runtimes
   * reporting `pending`. Counts and a boolean only; never an identifier, path or payload.
   */
  shutdownWorkInFlight(): { turns: number; builds: number; runtimes: number; stopping: boolean } {
    let runtimes = 0;
    for (const runtime of this.manager ? this.manager.all() : (this.runtime ? [this.runtime] : [])) {
      if (runtime.getShutdownDisposition() === 'pending') runtimes += 1;
    }
    return {
      turns: this.inboundTurnsInFlight,
      builds: this.manager?.pendingBuildCount() ?? 0,
      runtimes,
      stopping: this.stopping,
    };
  }

  async stop(): Promise<void> {
    // Both early returns are idempotent no-ops: a second stop() during normal shutdown is not an
    // event, and reporting one would teach an operator to ignore this channel.
    if (this.stopped) return;
    if (this.stopPromise) return this.stopPromise;
    const startedAt = this.clock.now().getTime();
    this.stopping = true;
    // Abort in-flight media intake first so a `stage()` in progress stops writing before the drain.
    this.mediaIntake.abort();
    this.runtime?.beginStopping();
    const shared = this.stopResources()
      .then(() => {
        this.emit({ stage: 'start-stop', operation: 'stop', outcome: 'stopped', durationMs: this.elapsedSince(startedAt) });
      })
      .catch((error: unknown) => {
        this.emit({
          stage: 'start-stop',
          outcome: 'failed',
          reason: 'release-failed',
          operation: 'stop',
          durationMs: this.elapsedSince(startedAt),
        });
        throw error;
      })
      .finally(() => {
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
        // Drains and closes every built profile's runtime.
        await this.manager.drainAndCloseAll();
      } else {
        // Test-double seam: start() never ran, so close the directly attached runtime.
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
   * Start each built profile's own heartbeat scheduler. The Router already exists by now, so
   * scheduler recovery cannot reach `requireRouter()` before it is created. Without a manager
   * (test double) only the attached runtime is started.
   */
  private async initializeScheduler(): Promise<void> {
    if (!this.config.heartbeat.enabled || !this.channel) return;
    const runtimes = this.manager ? this.manager.all() : (this.runtime ? [this.runtime] : []);
    for (const runtime of runtimes) {
      if (!runtime.agentLoop || !runtime.sessions) continue;
      if (!runtime.scheduler) {
        await runtime.initializeScheduler({
          schedulerPaths: this.schedulerPathsFor(),
          // The trigger captures this profile's runtime (the job's chatId never re-selects one), and the
          // destination guard makes the scheduler refuse addresses the profile does not own.
          runScheduledJob: (job) => this.handleScheduledJob(job, runtime, true),
          canAddressChat: (chatId) => this.canChatIdAddressProfile(chatId, runtime.profileId),
        });
      }
      if (runtime.scheduler) {
        const startupChatId = await this.resolveStartupPolicyChatIdFor(runtime);
        if (startupChatId) await this.reconcileHeartbeatPolicies(startupChatId);
        await syncHeartbeatMarkdown(runtime.workspace, await runtime.scheduler.listJobs());
      }
    }
  }

  /** Scheduler paths for the owner, derived from the same bundle as every other owner resource. */
  private schedulerPathsFor(): { storePath: string; auditLogPath: string } {
    const ownerPaths = this.ownerPaths();
    return { storePath: ownerPaths.schedulerStore, auditLogPath: ownerPaths.auditLog };
  }

  /**
   * Destination-ownership predicate: `chatId` may be addressed by work running as `profileId` only when
   * the current owner record binds that chat to that owner identity. Side-effect-free and fail-closed:
   * no admission authority, or a lookup failure (logged sanitized), means false. `job.chatId` is a
   * destination, never authority.
   */
  private canChatIdAddressProfile(chatId: string, profileId: ProfileId): boolean {
    // Work dispatched as another identity may not address this daemon's single owner destination.
    if (this.admissionOwnerId !== profileId) return false;
    try {
      return this.admission.ownsDestination(chatId);
    } catch (error) {
      console.warn('[gateway] Scheduled-work destination lookup failed; refusing:', summarizeErrorForLog(error));
      return false;
    }
  }

  private async recordSuppressedOutcomeOnOwner(owner: ProfileRuntime, jobId: string): Promise<void> {
    const scheduler = owner.scheduler;
    if (!scheduler) return;
    try {
      await scheduler.recordOutcome(jobId, 'skipped-unowned-chat');
    } catch (recordError) {
      console.warn('[gateway] Failed to record unowned-chat suppression:', summarizeErrorForLog(recordError));
    }
  }

  /**
   * Scheduled dispatch requires an explicit trusted runtime: `owner` is the runtime whose scheduler
   * fired this job, and `job.chatId` never re-selects one. A foreign or unpaired destination is
   * refused before any session, tool, model, delivery-policy or channel work.
   */
  private async handleScheduledJob(
    job: HeartbeatJob,
    owner: ProfileRuntime,
    invokedByScheduler = false,
  ): Promise<void> {
    if (this.stopping) return;
    if (!this.canChatIdAddressProfile(job.chatId, owner.profileId)) {
      console.warn(
        `[gateway] Suppressing heartbeat job ${job.id}: destination chat is not owned by profile "${owner.profileId}".`,
      );
      await this.recordSuppressedOutcomeOnOwner(owner, job.id);
      return;
    }
    const runtime = owner;
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

    // The destination can be reassigned while the model runs, so ownership is re-checked before send
    // and before recording an outcome: a mid-turn reassignment is suppressed, never delivered or
    // recorded as success.
    let delivered = false;
    try {
      // A per-occurrence turnId gives ledger writes a deterministic idempotency key, so a scheduler retry dedupes.
      const turnId = heartbeatTurnId(job);
      const result = await coordinator.runHeartbeat({
        chatId: job.chatId,
        input,
        turnId,
        egress: async (text) => {
          if (!this.canChatIdAddressProfile(job.chatId, owner.profileId)) {
            throw new HeartbeatDestinationSuppressedError();
          }
          await this.channel!.send(job.chatId, { text });
          delivered = true;
        },
        afterDelivery: async (agentResult) => {
          if (!delivered && !this.canChatIdAddressProfile(job.chatId, owner.profileId)) {
            throw new HeartbeatDestinationSuppressedError();
          }
          await scheduler?.recordOutcome(job.id, agentResult.text === HEARTBEAT_NOOP ? 'noop' : 'sent');
          await this.reconcileAfterScheduledDelivery(job.chatId, owner);
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
      if (error instanceof HeartbeatDestinationSuppressedError) {
        console.warn(
          `[gateway] Suppressing heartbeat delivery for job ${job.id}: destination left this profile's ownership mid-turn.`,
        );
        await this.recordSuppressedOutcomeOnOwner(owner, job.id);
        return;
      }
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

  private async reconcileAfterScheduledDelivery(chatId: string, owner: ProfileRuntime): Promise<void> {
    try {
      // Reconciliation stays owner-bound: if ownership no longer holds, skip rather than re-resolve another runtime.
      if (!this.canChatIdAddressProfile(chatId, owner.profileId)) {
        console.warn(
          '[gateway] Skipping post-delivery heartbeat reconciliation: destination is no longer owned by this profile.',
        );
        return;
      }
      await this.reconcileHeartbeatPoliciesOnRuntime(owner, chatId);
    } catch (error) {
      console.warn('[gateway] Post-delivery heartbeat reconciliation failed:', summarizeErrorForLog(error));
    }
  }

  /**
   * Reconcile against the runtime owning `chatId` (its scheduler and workspace), never the ambient
   * default, so a chat's reconcile only writes that profile's `HEARTBEATS.md` and scheduler store.
   */
  private async reconcileHeartbeatPolicies(chatId: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    // Sync-first: already-built profiles resolve with no async hop (the debounce path relies on that
    // timing); the async fallback builds a profile paired after boot. For non-job callers only;
    // scheduled delivery uses the owner-bound path below.
    const runtime = this.runtimeForChatSync(chatId) ?? await this.runtimeForChat(chatId);
    if (!runtime?.scheduler) {
      return;
    }
    // Fail closed: an unpaired chat (or a lookup failure) must not arm policy jobs. Degrade here with
    // a sanitized warning instead of propagating a createJob ownership error.
    if (!this.canChatIdAddressProfile(chatId, runtime.profileId)) {
      console.warn('[gateway] Skipping heartbeat policy reconciliation: chat is not owned by the resolving profile.');
      return;
    }
    await this.reconcileHeartbeatPoliciesOnRuntime(runtime, chatId);
  }

  /**
   * The reconcile body, bound to an explicit runtime: the owning runtime after a scheduled delivery,
   * or the chat-resolved runtime for non-job callers.
   */
  private async reconcileHeartbeatPoliciesOnRuntime(runtime: ProfileRuntime, chatId: string): Promise<void> {
    const scheduler = runtime.scheduler;
    if (!scheduler) {
      return;
    }
    const desired = await buildDesiredHeartbeatJobs({
      workspacePath: runtime.workspace,
      chatId,
      timezone: this.config.heartbeat.timezone,
      policy: this.config.heartbeat.policy,
    });
    await reconcilePolicyJobs(scheduler, desired);
    await syncHeartbeatMarkdown(runtime.workspace, await scheduler.listJobs());
  }

  private async debouncedReconcile(chatId: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    // Resolve synchronously so the debounce timer is scheduled synchronously.
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

  /** Startup-policy chat for the default (attached) runtime; kept for the single-runtime surface. */
  private async resolveStartupPolicyChatId(): Promise<string | undefined> {
    return this.resolveStartupPolicyChatIdFor(this.runtime);
  }

  /**
   * Startup-policy chat scoped to one profile's runtime: its most recent session chat or scheduler job.
   * Only reads; it never pairs a chat at boot.
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
    // Track on the owning runtime so each profile's shutdown drain accounts for its own reconciles.
    // Stays synchronous so the timer callback's fire-and-track semantics hold under fake timers.
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

  /**
   * Build the one runtime this daemon serves. Every path comes from the owner's derived path bundle,
   * so nothing can exist outside the leased owner workspace.
   */
  private async buildRuntimeFor(profileId: ProfileId): Promise<ProfileRuntime> {
    const { config } = this;
    const ownerPaths = this.ownerPaths();

    // A request for any other identity is refused rather than served from the owner's resources.
    if (profileId !== ownerPaths.profileId) {
      throw new Error(`Refusing to build a runtime for "${profileId}": this daemon serves owner "${ownerPaths.profileId}".`);
    }

    const workspace = ownerPaths.workspace;
    try {
      ensureWorkspaceBootstrap(workspace, {
        preserveExisting: true,
        log: (message) => console.log(`[gateway] ${message}`),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Workspace bootstrap failed for owner "${ownerPaths.profileId}": ${message}`);
    }

    this.resolvedMemoryWorkspace = workspace;

    return ProfileRuntime.create({
      profileId: ownerPaths.profileId,
      workspace,
      dbPath: ownerPaths.searchDb,
      sessionsPath: ownerPaths.sessions,
      schedulerPaths: {
        storePath: ownerPaths.schedulerStore,
        auditLogPath: ownerPaths.auditLog,
      },
      config,
      mainProvider: this.mainProvider!,
      createProvider: this.buildProvider,
      semaphore: this.semaphore!,
      // The scheduler is initialized after boot (initializeScheduler), once the concrete runtime exists
      // to capture in the trigger closure, so recovery cannot invoke a callback before create returns.
      // canSchedule stays false for the same reason.
      canSchedule: false,
      reconcile: (chatId) => this.debouncedReconcile(chatId),
      sideEffectLookup: (entity) => this.lookupSideEffects(this.sideEffectProvider ?? this.mainProvider!, entity),
    });
  }

  /**
   * The derived-path bundle for the selected owner, computed once. It never falls back to a default
   * identity or home-relative path; a config without a valid owner throws.
   */
  private ownerPaths(): OwnerPaths {
    if (this.ownerPathsCache) return this.ownerPathsCache;
    const profilesConfig = this.config.profiles;
    const ownerId = asProfileId(profilesConfig?.defaultProfileId ?? '');
    if (!profilesConfig || ownerId === undefined) {
      throw new Error('Refusing to serve: no valid owner identity is configured. Re-run setup.');
    }
    this.ownerPathsCache = resolveOwnerPaths(profilesConfig.baseDir, ownerId);
    return this.ownerPathsCache;
  }

  /** The owner, and only the owner. */
  private pairedProfileIds(): ProfileId[] {
    return [this.ownerPaths().profileId];
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

  /** Owner-scoped incoming media staging directory, inside the owner's workspace. */
  private mediaStagingDir(): string | undefined {
    const base = this.getEffectiveWorkspace();
    return base ? path.join(base, '.state', 'media-staging') : undefined;
  }

  /**
   * The trusted ancestor for the staging sweep and adoption: the owner's own workspace. A config that
   * names no owner workspace yields `undefined`, so staging is unavailable rather than throwing.
   */
  private ownerStagingBase(): string | undefined {
    const base = this.getEffectiveWorkspace();
    return base === '' ? undefined : base;
  }

  /**
   * The Gateway's one media stager, memoised. Its active/waiting counters implement the intake
   * concurrency bound, so it must not be rebuilt per message. `undefined` when no media source was
   * injected; media is only staged through it, and only after admission.
   */
  private mediaStager(): FsMediaStager | undefined {
    const stagingDir = this.mediaStagingDir();
    if (!this.mediaSource || !stagingDir) return undefined;
    this.mediaStagerCache ??= new FsMediaStager(this.mediaSource, stagingDir, {
      trustedBaseDir: this.ownerStagingBase(),
      diagnostics: this.sink,
    });
    return this.mediaStagerCache;
  }

  /**
   * An unpaired installation: connect the channel so a code can be sent, and route every message
   * through pairing/canned-emergency policy. Deliberately builds NO provider, workspace, runtime,
   * manager or scheduler — there is nothing to serve yet.
   */
  private async startUnpaired(config: EffectiveConfig): Promise<void> {
    this.stopping = false;
    this.stopped = false;
    if (config.channels.telegram.enabled) {
      const token = config.channels.telegram.botToken || process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        throw new Error('TELEGRAM_BOT_TOKEN not set. Set it in config or environment.');
      }
      this.channel = new TelegramChannel(token);
      this.channel.onMessage((msg) => this.handleMessage(msg));
    }

    this.router = this.createRouter();
    console.log('[gateway] Owner is not paired yet: serving pairing only. Run `medclaw pairing issue`, then send the code from the owner chat.');

    if (this.channel && typeof this.channel.connect === 'function') {
      await this.channel.connect();
    }
  }

  private createRouter(): GatewayMessageRouter {
    return new GatewayMessageRouter({
      config: this.config,
      runtime: this.runtime,
      admission: this.admission,
      ownerId: this.admissionOwnerId,
      stagingDir: this.mediaStagingDir(),
      // The trusted base is the owner's own workspace, never `$HOME`: a home-wide base let one
      // installation adopt or delete another installation's staged file.
      stagingBaseDir: this.ownerStagingBase(),
      buildBootStatusText: () => this.buildBootStatusText(),
      // Dispatch every turn to the runtime owning the resolved profile. Without a manager (test
      // double) every profile resolves to the single attached runtime. Never rejects: a degraded
      // profile yields `undefined` and the Router sends the canned degraded reply.
      resolveRuntime: (profileId) => this.resolveRuntimeForProfile(profileId),
    });
  }

  /**
   * The per-profile runtime accessor every dispatch path uses. A persistently broken profile
   * degrades to `undefined` with a sanitized log, never a throw to the daemon.
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

  /**
   * The runtime that owns `chatId`, or `undefined`. Ownership is the owner record (via
   * `canChatIdAddressProfile`), so an unbound chat resolves to nothing, never a default profile.
   */
  private async runtimeForChat(chatId: string): Promise<ProfileRuntime | undefined> {
    const ownerPaths = this.ownerPaths();
    if (!this.canChatIdAddressProfile(chatId, ownerPaths.profileId)) return undefined;
    return this.resolveRuntimeForProfile(ownerPaths.profileId);
  }

  /** Synchronous twin of `runtimeForChat` for the timer-driven reconcile path: never builds or awaits. */
  private runtimeForChatSync(chatId: string): ProfileRuntime | undefined {
    const ownerPaths = this.ownerPaths();
    if (!this.canChatIdAddressProfile(chatId, ownerPaths.profileId)) return undefined;
    if (this.manager) return this.manager.getIfBuilt(ownerPaths.profileId);
    return this.runtime;
  }

  /** Whether `chatId` is a destination this daemon's owner may address (the owner record, fail-closed). */
  private chatBelongsToProfile(chatId: string, profileId: ProfileId): boolean {
    return this.canChatIdAddressProfile(chatId, profileId);
  }

  private requireRuntimeForAccess(): ProfileRuntime {
    if (!this.runtime) throw new Error('Gateway runtime must be attached or started before field access');
    return this.runtime;
  }

  private requireRouter(): GatewayMessageRouter {
    if (!this.router) this.router = this.createRouter();
    return this.router;
  }

}
