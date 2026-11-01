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

/**
 * Required collaborators for a production Gateway. S1 makes admission non-optional in
 * composition; it stays optional on the constructor only so the pre-S1 direct-construction tests
 * can still describe a single-runtime world. A Gateway booted WITHOUT admission has no enrollment
 * authority at all and must not be used to serve a real owner.
 */
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
  /**
   * The owner's enrollment authority. REQUIRED.
   *
   * It used to be optional so pre-S1 tests could construct a Gateway with no identity at all. That
   * optionality was load-bearing in the worst way: `if (this.admission)` in `start()` skipped the
   * entire refusal policy, and `admitAndStage` passed media and text straight through, so a Gateway
   * built without it served as though every chat were the owner. Plan 15 §5 requires that "New core APIs
   * must not have an optional admission fallback". It is now non-optional, and `ownerPaths()` refuses a
   * config that names no valid owner.
   */
  admission: OwnerAdmissionService;
  /** The owner identity `admission` is configured for. REQUIRED; never inferred, never defaulted. */
  ownerId: ProfileId;
  /**
   * How providers are constructed for this daemon (plan 15 §3 `GatewayBindings`).
   *
   * Production composition supplies the real factory explicitly rather than letting the Gateway and
   * `ProfileRuntime.create` each reach for one internally — that hidden creation is what made a
   * real owner spine untestable without live providers. Defaults to the real factory, so a caller
   * that omits it gets exactly the previous production behaviour.
   */
  createProvider?: ProviderFactory;
  /**
   * How attached media bytes are retrieved (plan 15 §2.5). Supplied by production composition.
   * Absent it, media is refused rather than silently dropped — a transport that cannot retrieve
   * bytes must not appear to succeed.
   */
  mediaSource?: MediaSourcePort;
  /**
   * The closed diagnostic contract, covering admission, pairing, media intake and start/stop.
   * Silent for reusable direct construction. The daemon root explicitly selects its output adapter.
   */
  diagnostics?: DiagnosticSink;
  /** Optional: defaults to the system clock. Injected in tests so durations are real measurements. */
  clock?: Clock;
}

const SHUTDOWN_RESPONSE = 'The health assistant is shutting down. Please try again in a moment.';
const BOOT_HEALTHCHECK_BUDGET_MS = 3_000;

/**
 * RR2-B1 (R2-10/11): a narrow, gateway-local boundary representing an AUTHORIZATION
 * suppression of a scheduled delivery — the destination chat stopped belonging to the owning
 * profile between dispatch and egress. Deliberately NOT an operational/provider error: it must
 * never enter `recordFailure`'s retry/dead-letter state machine, and it must never let
 * `afterDelivery` record an honest-looking sent/noop. Module-local by design — no other
 * consumer may throw or catch it.
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
 * C01 follow-up (R01): `serveOwner()` refused to replace a runtime generation that still has unsettled
 * resource-touching work.
 *
 * A dedicated type rather than a string match, because the refusal needs one honest diagnostic
 * (`start-stop`/`refused`) instead of two contradictory ones: `start()`'s generic catch would otherwise
 * also report `failed`/`build-failed` for a start that built nothing at all. Carries no owner, chat or
 * path data — the message is fixed operator guidance.
 */
class PreviousWorkUnsettledError extends Error {}
class AdmissionRefusedError extends Error {}

export class Gateway {
  private config: EffectiveConfig;
  private channel?: Channel;
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
  /** Inbound turns that have started and not settled. Drives `getShutdownDisposition()`. */
  private inboundTurnsInFlight = 0;
  private stopPromise?: Promise<void>;
  private runtime?: ProfileRuntime;
  /** RR-STRUCT R-S5a (mini-plan v3 §3.3): owns one ProfileRuntime per paired profile. `this.runtime`
   *  above stays the DEFAULT profile's runtime (`manager.get(defaultProfileId)`) — every existing
   *  accessor/handler/Router keeps reading `this.runtime` unchanged; dispatch stays default-only
   *  (the RR-4 refusal is untouched — R-S5b routes by profile and retires it). */
  private manager?: ProfileRuntimeManager;
  private router?: GatewayMessageRouter;
  /** Overrides the legacy paired-profile enumeration while serving pairing only. */

  /**
   * S1 admission. When supplied, it is the sole authority for who may reach a clinical runtime,
   * and its boot answer decides whether one may be built at all. Absent only for pre-S1 tests that
   * construct a Gateway directly with a hand-built runtime.
   */
  private admission: OwnerAdmissionService;
  /**
   * Set when the owner record is not yet bound. While true the daemon serves pairing and canned
   * emergency guidance only: no provider, no workspace bootstrap, no runtime, no index, no
   * scheduler. This is what keeps "unpaired" from quietly meaning "serving on a default identity".
   */
  private unpairedOnly = false;
  /** The owner identity admission is configured for, used as the dispatch target when admitted. */
  private admissionOwnerId: ProfileId;
  /**
   * The ONE derivation of this owner's resources, memoised from the validated config.
   *
   * S1 change: every durable path used to be resolved through the legacy `ProfileRegistry`
   * migration branch (`migrateAndResolveWorkspace` / `hasBeenMigrated` / `resolveSchedulerPaths`),
   * which could silently place the search database and session transcripts BESIDE — outside — the
   * leased owner workspace. `config.profiles.baseDir` + `defaultProfileId` are mandatory in schema v2,
   * so the Gateway derives the identical bundle with the identical pure function composition uses.
   */
  private ownerPathsCache?: OwnerPaths;
  private readonly buildProvider: ProviderFactory;
  private readonly mediaSource?: MediaSourcePort;
  private readonly sink: DiagnosticSink;
  /** Injected so a start/stop duration is measured, not guessed. */
  private readonly clock: Clock;
  /**
   * Abort signal for in-flight media intake.
   *
   * Created in the constructor rather than lazily inside `serveOwner`, because it has to outlive any
   * single promotion: a controller created per promotion would only ever abort that promotion's
   * downloads. `stop()` aborts it, which is what finally makes the comment on the intake path true.
   *
   * NOT `readonly`, and re-armed by `start()`. `stop()` aborting this controller is permanent for the
   * object, so a `readonly` field meant a restarted Gateway refused every subsequent attachment with
   * "That upload was cancelled" — forever, with no recovery short of constructing a new Gateway.
   * `start()` -> `stop()` -> `start()` is an existing, exercised contract (see
   * `tests/gateway/gateway-transcript-sweep.test.ts`), so this was a real latent break, not a
   * theoretical one.
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
    const startedAt = this.clock.now().getTime();
    try {
      await this.startServing();
    } catch (error) {
      // C01 follow-up (R01): the replacement refusal gets its OWN truthful outcome. Reporting
      // `failed`/`build-failed` for it would be a lie twice over — nothing was built, and the refusal
      // has to be distinguishable from a real build failure by an operator reading the sink.
      // `durationMs` is the real elapsed start span, measured here rather than fabricated at the
      // refusal site, which has no start timestamp.
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

    // ── S1 admission comes first ──────────────────────────────────────────────────────────
    // A missing, unreadable, corrupt or wrong-owner record must NOT boot into a serving state,
    // and an unpaired record must NOT build anything clinical. Both decisions are taken before a
    // provider is created, before the workspace is touched, and before any index or scheduler
    // exists, so "unpaired" cannot degrade into "serving on a default identity".
    // Re-arm intake for this run of the daemon. `stop()` aborted the previous controller, and an
    // aborted signal cannot be un-aborted, so a restart needs a fresh one.
    this.mediaIntake = new AbortController();

    const admissionState = this.admission.inspectInstallation();
    if (admissionState.kind === 'refused') {
      // start() owns the one terminal result. Admission has already emitted the precise reason.
      throw new AdmissionRefusedError(
        `Refusing to serve: the owner record is ${admissionState.reason}. `
        + 'Re-run setup on this computer, then start the daemon again.',
      );
    }
    // ── The staging sweep. BOOT ONLY, and this is its only call site. ──
    //
    // It used to live inside `serveOwner`, which is shared by boot AND the mid-session unpaired ->
    // bound promotion. That placement is what made it dangerous, and this module's README already
    // stated the intended rule: "sweepStagedMedia is exported because boot must call it, and boot is
    // the only safe moment". Two failures came from the old placement:
    //
    //   1. `unpairedOnly` is cleared only at the END of `serveOwner`, so a promotion that failed
    //      anywhere earlier left it set and the NEXT owner message re-entered and swept again — this
    //      time over a lane holding live staged media.
    //   2. The sweep was never mutually exclusive with `stager.stage(...)`. Two messages interleave,
    //      so one could be mid-download while the other's promotion swept the lane underneath it,
    //      deleting a file the owner was actively uploading.
    //
    // Here it runs once, after admission has confirmed the record belongs to this owner and while
    // `startDaemon` still holds the workspace lease, and before any intake is accepted. An unpaired
    // boot sweeps too: nothing can be in flight yet, so there is nothing to destroy, and it keeps
    // S1-R-01 true for a daemon that pairs later.
    this.sweepOwnerStagingLane();

    if (admissionState.kind === 'unpaired') {
      this.unpairedOnly = true;
      await this.startUnpaired(config);
      return;
    }

    await this.serveOwner({ connectChannel: true, runHealthchecks: true });

    console.log('[gateway] Redacted is running.');
  }

  /**
   * Build everything that only the BOUND owner may have: workspace, providers, the runtime, the
   * router and the scheduler.
   *
   * This is the single implementation of "serve the owner", shared by two callers:
   *
   * - `start()` on a boot whose record is already bound, and
   * - the unpaired -> bound transition in `ensureOwnerServing`, which fires on the first admitted
   *   owner message after the owner sends their pairing code.
   *
   * It used to be inline in `start()`, which meant a daemon that booted unpaired could never serve
   * the owner: pairing bound the record, but nothing rebuilt a runtime, so every later message was
   * answered with the canned "profile temporarily unavailable" until the operator restarted. The
   * restart was never documented anywhere.
   */
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
   * C01 follow-up (R01): whether replacing the runtime generation currently installed on this Gateway
   * would hide work that can still touch owner resources.
   *
   * Read from exactly the sources `stopResources()` drains and `getShutdownDisposition()` reports — an
   * unfinished stop, a construction still in flight, and the manager's resolved runtimes (or the
   * directly attached fallback) — so this can never disagree with the disposition root releases on.
   *
   * Two conditions are deliberately NOT here. An in-flight inbound turn needs no guard: the counter
   * lives on the Gateway, so replacement does not hide it, and the drain already awaits turns under
   * the same bounded budget (the post-drain re-check below catches the case where that budget expires).
   * And a "replacement already refused" flag is not here, because a flag would be a permanent
   * closed-flag refusal that no amount of real settlement could clear.
   *
   * Deliberately NOT a retained list of retired generations: pruning such a list requires observing
   * each old runtime's settlement, which is not available synchronously, so it would grow without
   * bound or need polling (spec16 §1/§3, and brief §8.2).
   */
  private replacementWouldHideLiveWork(): boolean {
    // An unfinished stop means this Gateway is mid-teardown. Replacing the generation now would
    // redirect `stopResources()`'s drain at the NEW manager and strand the old one entirely.
    if (this.stopPromise) return true;
    // An un-settled construction is awaited by `ProfileRuntimeManager.performDrain()` with NO budget
    // of its own (`manager.ts:154`), so replacing nothing here would let `start()` block forever.
    if ((this.manager?.pendingBuildCount() ?? 0) > 0) return true;
    const runtimes = this.manager ? this.manager.all() : (this.runtime ? [this.runtime] : []);
    for (const runtime of runtimes) {
      if (runtime.getShutdownDisposition() === 'pending') return true;
    }
    return false;
  }

  /**
   * Throw the R01 replacement refusal. One message, no owner/chat/path data, and no mutation: the old
   * generation stays installed, visible to the disposition, and drainable by `stopResources()`.
   */
  private refuseRuntimeReplacement(): never {
    throw new PreviousWorkUnsettledError(
      'Refusing to serve: the previous runtime still has work in flight that can write to this '
      + 'installation, so ownership cannot be handed to a replacement. Wait for it to finish, then '
      + 'start the daemon again.',
    );
  }

  private async serveOwner(options: { connectChannel: boolean; runHealthchecks: boolean }): Promise<void> {
    const { config } = this;

    // C01 follow-up (R01), FIRST of two checks: refuse to REPLACE a generation that already owns
    // resource-touching work.
    //
    // `drainAndCloseAll()` further down is bounded and memoized — it resolves at the shared drain
    // budget whether or not the old runtime actually settled. Overwriting `this.manager` therefore
    // proves nothing finished; it only makes the old continuation unreachable from
    // `getShutdownDisposition()`, which is how a timed-out sweep became invisible to root and let a
    // second installation acquire a workspace the old runtime was still writing to.
    //
    // Placed at the TOP of the method, before any provider, runtime, router or scheduler is built, so
    // a refusal cannot leave a half-built serving generation behind. It is here rather than in
    // `start()` because `serveOwner` is the single replacement site shared by BOTH callers — the boot
    // and the unpaired->bound promotion re-entry — and patching one caller would leave the other open.
    if (this.replacementWouldHideLiveWork()) this.refuseRuntimeReplacement();

    // The owner's derived paths. Resolved once, here, so a config that cannot name a valid owner
    // refuses the boot BEFORE a provider, a runtime or a scheduler exists.
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
      // The channel emits media references only — it never downloads, writes or names a file, so it
      // takes no staging path. Containment is `FsMediaStager`'s, bound to the owner's lane at
      // composition. `deliverMessage` -> `admitAndStage` is what decides whether bytes are fetched.
      this.channel = new TelegramChannel(token);
      this.channel.onMessage((msg) => this.handleMessage(msg));
    }

    // RR-STRUCT R-S5a (mini-plan v3 §3.3): ProfileRuntimeManager owns one ProfileRuntime per
    // paired profile. The DEFAULT profile is built first and DIRECTLY (not via buildAll) so its
    // failure semantics stay byte-identical to pre-R-S5a: exactly one build attempt, and a
    // genuine failure propagates straight out of start() (see tests/gateway/memcore-wiring.test.ts
    // "aborts boot when the SAFETY.md injection invariant is violated"). Every OTHER paired
    // profile is then eager-built via buildAll — individually guarded, so a secondary profile's
    // broken storage degrades only that profile and never touches the default or aborts boot.
    // Drain any runtime from an EARLIER entry into this method before replacing it.
    //
    // A promotion that fails after this point leaves `unpairedOnly` set, so the next owner message
    // re-enters `serveOwner` and reaches this line again. It no longer simply overwrites: the two R01
    // checks decide whether replacement is allowed at all, and when it is allowed the previous manager
    // is drained here first — `stopResources` only ever drains the CURRENT manager, so skipping this
    // would leave the previous one holding open handles against owner state for the rest of the
    // process. Draining first makes re-entry safe rather than merely survivable.
    if (this.manager !== undefined) {
      try {
        await this.manager.drainAndCloseAll();
      } catch (error) {
        // A failure to drain the old runtime must not stop the new one from being built, or a retry
        // could never make progress. It is reported, not swallowed.
        console.warn('[gateway] Failed to drain the previous runtime before rebuilding:', summarizeErrorForLog(error));
      }
      // C01 follow-up (R01), SECOND of two checks, and the load-bearing one: this drain can CREATE
      // pendingness on the very generation it is draining. `drainAndClose()` registers each phase in
      // the runtime's `unsettledDrainWork`, and a phase abandoned at the shared 10,000ms budget stays
      // there — so a generation that was quiescent a moment ago can be `pending` by the time control
      // reaches here. A `session-compactions` phase awaiting a compaction, or a `scheduler-stop`
      // awaiting a stalled heartbeat, are both real shapes: neither is a source of
      // `ProfileRuntime.getShutdownDisposition()`, so only this re-check sees them.
      //
      // The drain is memoized, so re-checking is free and non-destructive, and it is placed
      // immediately before the overwrite with nothing in between — the check and the thing it guards
      // are now adjacent rather than separated by the operation that invalidates the check.
      if (this.replacementWouldHideLiveWork()) this.refuseRuntimeReplacement();
    }

    this.manager = new ProfileRuntimeManager((id) => this.buildRuntimeFor(id));
    this.runtime = await this.manager.get(profileId);
    await this.manager.buildAll(this.pairedProfileIds());

    this.router = this.createRouter();
    if (options.connectChannel && this.channel && typeof this.channel.connect === 'function') {
      await this.channel.connect();
    }

    // `stop()` may have begun while this build was in flight. Everything above is drainable through
    // `this.manager`, but a scheduler started now would have no owner left to stop it and would never be
    // drained. Bail out instead: the daemon is shutting down, so leaving `unpairedOnly` set is correct.
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

  /**
   * Local-transport test seam. NOT a serving path.
   *
   * It presents an explicit `local` transport identity rather than none, because admission refuses a
   * message with no transport identity — and silently omitting it would make this path untestable and
   * its refusals meaningless. Because the identity is `local`, this seam only reaches the owner when the
   * owner was bound over `local`; against a Telegram binding it is correctly refused as a stranger.
   *
   * It used to call `requireRouter().route(...)` directly. To be precise about what that did and did
   * not mean: it was NOT an admission bypass, because `route()` runs `admission.inspect()` before
   * anything else. What it DID skip is the front half of `deliverMessage`:
   *
   *   - `ensureOwnerServing`, so a daemon that booted unpaired and then paired could NOT be driven to
   *     build its runtime through this seam, even though a real Telegram message would build it; and
   *   - `admitAndStage`, so the admitted-message normalisation and its `mediaError` handling never ran.
   *
   * So this seam could not serve a stranger, but it was not the same path production takes, and a test
   * using it was asserting against a subtly different machine. It now delegates to `deliverMessage`, so
   * a test exercises the same admission and promotion path a real message takes.
   *
   * Note this seam takes no media: its signature has no place to put a `MediaReference`. Tests that need
   * admitted media must drive `deliverMessage` directly, which is what the media suites do.
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

  /**
   * The Telegram channel's inbound callback. A thin edge adapter over `deliverMessage` — it supplies
   * the channel's egress and nothing else.
   *
   * It used to call `route()` directly, which meant the channel's messages never passed through
   * admission-staged media: an attachment arrived as a `MediaReference` that nothing ever retrieved,
   * and the placeholder text the channel substitutes ("Sent a photo") reached the model as if it were
   * the whole message. There is now exactly one inbound path.
   */
  private async handleMessage(incoming: IncomingMessage): Promise<void> {
    try {
      await this.deliverMessage(incoming, (text) => this.channel!.send(incoming.chatId, { text }));
    } catch (error) {
      console.error('[gateway] Handler error:', summarizeErrorForLog(error));
    }
  }

  /**
   * The one inbound path every transport shares.
   *
   * `handleMessage` delegates here with the Telegram channel's egress. A non-Telegram edge adapter
   * calls the same method with its OWN egress (plan 15 §3: "Future CLI normalizes identity/media
   * through its own edge adapter and calls the same admission/turn/action seams; it does not
   * pretend a CLI conversation has Telegram identity").
   *
   * This is the seam that lets the acceptance spine exercise the REAL admission, router and runtime
   * with a genuine `telegram` transport identity without standing up a polling bot. It is not a
   * bypass: admission sees exactly the identity the transport supplied, so a caller cannot use it
   * to claim an identity it does not have.
   */
  async deliverMessage(incoming: IncomingMessage, egress: (text: string) => Promise<void>): Promise<void> {
    if (this.stopping) return;
    // A daemon that booted unpaired has no runtime. If the owner has since paired, THIS is the moment
    // to build one — see `ensureOwnerServing`. Checked before staging so the transition never races a
    // retrieval it would then have to discard.
    // TRACKED. The promotion builds a provider, a runtime and a scheduler — real work touching owner
    // resources. Untracked, `getShutdownDisposition()` reported `quiescent` while it was still running
    // (this.manager is not assigned until the build finishes), so `startDaemon`'s shutdown released the
    // installation lease and a second daemon could enter the workspace we were still writing to.
    await this.trackInboundTurn(() => this.ensureOwnerServing(incoming));
    if (this.stopping) return;
    const admitted = await this.admitAndStage(incoming);
    if (!admitted) return;
    await this.trackInboundTurn(() => this.requireRouter().route(admitted, egress));
  }

  /**
   * Run the SAME admission policy used by text and scheduling, then stage any media, then re-check
   * authority before the turn begins.
   *
   * Order is the whole point (plan 15 §2.5): a denied identity never causes a fetch, a fetch never
   * happens for an unadmitted sender, and authority is re-read after the (slow) retrieval so a
   * binding that changed mid-download cannot be raced into a clinical turn.
   */
  /**
   * Promote a pairing-only daemon to a serving one, on the first admitted owner message.
   *
   * Boot decides admission ONCE, and an unpaired boot deliberately builds no provider, workspace,
   * runtime or scheduler. That is correct — but it left no path back. Pairing bound the record, and
   * every subsequent message resolved to a runtime that did not exist, so the owner was answered
   * "this chat's profile is temporarily unavailable" until they restarted a daemon nobody had told
   * them to restart. Requiring a restart is also wrong on its own terms: `pairing issue` refuses
   * while the daemon holds the installation lease, so the documented sequence already had the owner
   * stop and start the process by hand.
   *
   * Single-flight: two messages arriving together must not both build a runtime.
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

  private async admitAndStage(incoming: IncomingMessage): Promise<AdmittedMessage | undefined> {
    // Admission is REQUIRED, so there is no "no authority" branch left to fail closed in: the policy
    // always exists. This used to read `if (!admission) { if (incoming.media) return undefined; return
    // incoming as AdmittedMessage; }` — which handed an unadmitted sender a clinical turn whenever a
    // Gateway was composed without admission, and silently dropped the owner's media.
    const decision = this.admission.inspect(transportIdentityOf(incoming));
    const admitted: AdmittedMessage = { ...incoming };

    if (decision.kind !== 'owner') {
      // Not the owner, so NO media is fetched, staged or buffered — that is the whole security value of
      // this seam, and it holds equally for an unpaired owner, a stranger and a group.
      //
      // The message itself is still handed to the Router, which owns every refusal and pairing reply.
      // Dropping it here was wrong twice over:
      //   - it made pairing over a real transport unreachable, because the only caller of
      //     `handlePairing` lives inside `route()`, so the owner's code was discarded before it could
      //     bind and the promotion transition could never fire; and
      //   - it made a stranger's DM SILENT instead of answered with the canned refusal, because the
      //     Router is what sends that reply.
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
   * Run one inbound turn while it is visible to the shutdown disposition.
   *
   * A turn that has started and not yet settled may still read or write owner resources, so it is
   * counted. Admission-state replacement, media staging and their cleanup ride inside this same
   * window; S5 owns cancelling them, not deciding whether ownership may be released. Both entry
   * points go through here so the count cannot be bypassed by the test/dev path.
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
   * Whether anything that can still touch owner resources has settled.
   *
   * `pending` covers in-flight runtime construction, in-flight inbound turns (which include
   * admission-state replacement, media staging and their cleanup), an unfinished drain, and — since
   * C01 (R01) — any runtime continuation that started and has not really settled, including a drain
   * phase abandoned at the shared 10s budget. Only `quiescent` authorises releasing the
   * installation's resource ownership. A stop that returns after a timeout is NOT quiescence; S5
   * owns bounded cancellation and the shared stop deadline.
   */
  getShutdownDisposition(): 'quiescent' | 'pending' {
    if (this.stopPromise) return 'pending';
    if (this.inboundTurnsInFlight > 0) return 'pending';
    if (this.manager?.pendingBuildCount() ?? 0 > 0) return 'pending';
    // C01 (R01): a runtime that closed its stores while a drain phase was abandoned at the shared
    // budget still has a continuation that can write owner files. `closed` is not quiescence.
    // Read exactly the runtime sources `stopResources()` drains — the manager's resolved runtimes
    // and the directly attached fallback — so the test-double path is protected too.
    for (const runtime of this.manager ? this.manager.all() : (this.runtime ? [this.runtime] : [])) {
      if (runtime.getShutdownDisposition() === 'pending') return 'pending';
    }
    return 'quiescent';
  }

  /**
   * Counters behind the disposition, for honest local reporting and tests.
   *
   * `runtimes` counts the runtimes currently reporting `pending`. Without it the R01 production case
   * (a stuck nightly sweep, no inbound turn, no pending build) reports `turns=0, builds=0` on the one
   * path that tells the operator ownership was retained and the lease may need removing by hand — a
   * self-contradicting report. Counts and a boolean only; never an identifier, path or payload.
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
    // Abort in-flight media intake FIRST, before draining. Without this the comment on the intake
    // path was fiction: a `stage()` in progress kept streaming and writing after `stop()` returned,
    // burning the drain budget and leaving a partial behind. Plan 15 T4 requires abort on stop, and
    // review round 2 found (twice, independently) that nothing ever called this.
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
          schedulerPaths: this.schedulerPathsFor(),
          // RR2-B1: the trigger closure captures THIS profile's concrete runtime — the job's
          // `chatId` never re-selects a runtime — and the destination guard is threaded into
          // the scheduler so create/update/resume/registration refuse foreign addresses.
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

  /**
   * Scheduler paths for the owner. Derived from the same bundle as every other owner resource, so the
   * job store and audit log can no longer land on a legacy fallback path.
   */
  private schedulerPathsFor(): { storePath: string; auditLogPath: string } {
    const ownerPaths = this.ownerPaths();
    return { storePath: ownerPaths.schedulerStore, auditLogPath: ownerPaths.auditLog };
  }

  /**
   * RR2-B1 (R2-10/11) destination-ownership predicate: `chatId` may be addressed by work running as
   * `profileId` ONLY when the CURRENT owner record binds that chat to that owner identity.
   *
   * Side-effect-free and fail-closed. It reads exactly one thing — the owner record — and never
   * Router.resolveProfileForChat / getOrCreateDefaultProfile / pairChatToProfile, never the legacy
   * registry, and never builds or initializes a runtime. No admission authority means FALSE: there is no
   * implicit default authorization. Lookup failures are logged sanitized and refused.
   * `job.chatId` is a destination, never authority.
   *
   * It previously read `ProfileRegistry.getProfileForChat`. S1 made pairing the only route to a profile,
   * so nothing ever paired the registry and this returned `false` for the owner's own chat — with
   * `heartbeat.enabled` defaulting to true, the owner's reminders were inert in the shipped daemon while
   * still being armed at boot. See `OwnerAdmissionService.ownsDestination`.
   */
  private canChatIdAddressProfile(chatId: string, profileId: ProfileId): boolean {
    // Work dispatched as some OTHER identity may not address this daemon's single owner destination.
    // Multi-profile activation is parked, so there is exactly one dispatching identity that can pass.
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
   * RR2-B1: scheduled dispatch requires an explicit trusted runtime. `owner` is the
   * ProfileRuntime whose scheduler created/fired this job — every trigger closure captures
   * its concrete runtime at construction, so `job.chatId` never re-selects a runtime. All
   * session/turn/scheduler/outcome state stays on the owner; a foreign or unpaired
   * destination is refused BEFORE any session, tool, model, delivery-policy or channel work.
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

    // RR2-B1: the destination can be REASSIGNED while the model runs. Re-check ownership
    // immediately before channel.send (the delivery gate) and again before recording a
    // sent/noop outcome, so a mid-turn reassignment is refused and suppressed — never
    // delivered, never recorded as an honest success, never pushed into retry logic.
    let delivered = false;
    try {
      // RR-STRUCT R-S3b (C-39 for heartbeats): thread the per-occurrence turnId so a
      // `ledger_record` inside this turn gets a deterministic idempotency key — a
      // scheduler RETRY of this occurrence dedupes instead of double-writing.
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
      // RR2-B1: reconciliation after a scheduled job stays owner-bound. If ownership no
      // longer holds, skip — never re-resolve a now-foreign chat into another runtime.
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
    // boot that was never built (lazy serving). NON-JOB callers only (user-turn reconcile +
    // debounce + startup): scheduled delivery uses the owner-bound path below.
    const runtime = this.runtimeForChatSync(chatId) ?? await this.runtimeForChat(chatId);
    if (!runtime?.scheduler) {
      return;
    }
    // RR2-B1: fail-closed, matching the scheduler's createJob guard. An unpaired chat
    // (or a lookup failure) must not arm policy jobs on the resolved runtime — and the
    // refusal must degrade here (sanitized warn, no reconcile) instead of propagating a
    // createJob ownership error through reconcilePolicyJobs' rethrow path.
    if (!this.canChatIdAddressProfile(chatId, runtime.profileId)) {
      console.warn('[gateway] Skipping heartbeat policy reconciliation: chat is not owned by the resolving profile.');
      return;
    }
    await this.reconcileHeartbeatPoliciesOnRuntime(runtime, chatId);
  }

  /**
   * RR2-B1: the reconcile body, bound to an explicit runtime. Called by
   * `reconcileAfterScheduledDelivery` with the OWNING runtime (never a chat-derived
   * re-resolution), and by `reconcileHeartbeatPolicies` for non-job callers (existing
   * chat-resolution behavior retained there).
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

  /**
   * Build the ONE runtime this daemon serves, from this owner's derived paths and nothing else.
   *
   * S1 change (the retirement of the legacy migration branch): this used to branch on
   * `profileId === defaultProfileId`, call `migrateAndResolveWorkspace` — which copied the workspace
   * into a registry profile directory and sealed a sentinel — and fall back to `search.db` and
   * `sessions` paths one level ABOVE the workspace when that sentinel did not match. Since T1,
   * `config.memory.workspace` already IS `<baseDir>/profiles/<ownerId>`, so the "migration" copied a
   * directory onto itself, and because the sentinel was keyed on a hash of the SOURCE path while it was
   * sealed under the DEFAULT profile, the read and the write could never agree: the owner's whole PHI
   * tree was re-copied on every boot, forever, and the derived database could land outside the lease.
   *
   * Every path now comes from one pure derivation over already-validated config. There is no second
   * authority, no sentinel, no copy, and no path that can exist outside the leased owner workspace.
   */
  private async buildRuntimeFor(profileId: ProfileId): Promise<ProfileRuntime> {
    const { config } = this;
    const ownerPaths = this.ownerPaths();

    // Multi-profile activation is parked for S1. A request for any OTHER identity is refused rather
    // than silently served from the selected owner's resources.
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
      // RR-STRUCT R-S5a: scheduler recovery must not invoke a callback before ProfileRuntime.create
      // returns. Gateway explicitly initializes the runtime's scheduler AFTER boot
      // (initializeScheduler), where the concrete runtime exists to capture in the trigger closure and
      // the destination guard is threaded (RR2-B1).
      // RR2-B1: no owner-less `runScheduledJob` is passed here — a closure captured at build time
      // could not bind this runtime, and canSchedule stays false so the direct-factory activation path
      // (which requires canAddressChat) is not used.
      canSchedule: false,
      reconcile: (chatId) => this.debouncedReconcile(chatId),
      sideEffectLookup: (entity) => this.lookupSideEffects(this.sideEffectProvider ?? this.mainProvider!, entity),
    });
  }

  /**
   * The single derived-path bundle for the selected owner, computed once.
   *
   * `profiles.baseDir` and `defaultProfileId` are required by the schema-v2 decoder, so this cannot
   * fall back to a default identity or a home-relative path. A hand-built config that omits them is a
   * caller programming error and throws here rather than inventing a location.
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

  /** The owner, and only the owner. Multi-profile eager activation is retired in S1. */
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

  /**
   * Owner-scoped incoming media staging.
   *
   * S1 change (old -> new): this used to be `~/.redacted/.staging/media` — a HOME-wide location, so
   * two daemons sharing a home account swept and wrote into the same directory, and the boot sweep
   * deleted whatever it found there. It is now derived from the selected owner's paths, so staging
   * cannot exist without the owner whose lease this process holds.
   */
  private mediaStagingDir(): string | undefined {
    const base = this.getEffectiveWorkspace();
    return base ? path.join(base, '.state', 'media-staging') : undefined;
  }

  /**
   * The stager, or `undefined` when no media source was injected. Media is only ever staged through
   * this, and only after admission.
   */
  /**
   * The trusted ancestor for the staging sweep and adoption: the owner's own workspace.
   *
   * Uses the same effective-workspace resolution as the rest of the Gateway, so a configuration
   * that names no owner workspace yields `undefined` and staging is simply unavailable — rather than
   * throwing while routing a message.
   */
  private ownerStagingBase(): string | undefined {
    const base = this.getEffectiveWorkspace();
    return base === '' ? undefined : base;
  }

  /**
   * ONE stager for this Gateway, memoised.
   *
   * This used to construct `new FsMediaStager(...)` per inbound message. `FsMediaStager` keeps its
   * `active` / `waiting` / `slotWaiters` counters as INSTANCE fields, and those counters are what gate
   * the `MEDIA_MAX_ACTIVE = 1` / `MEDIA_MAX_WAITING = 4` module constants. A fresh instance per message
   * therefore always saw `0 >= 1`, so the concurrency queue never engaged, `wakeSlot()` was a no-op and
   * the `'queue-full'` refusal was unreachable in production: N simultaneous attachments meant N
   * simultaneous 10 MB streams against a disk and a network. `media-stager.ts` documented a bound it did
   * not enforce.
   *
   * The bound only bites when concurrent attachments actually happen, so this stayed invisible for as
   * long as no media source was wired — and would have detonated the moment one was.
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

  /**
   * The runtime that owns `chatId`, or `undefined`.
   *
   * S1 change: this resolved a chat through `ProfileRegistry.getProfileForChat` and, when the chat was
   * not in the registry, fell back to the DEFAULT profile — "unpaired == default". That fallback is the
   * silent grant that let any chat select a runtime. Ownership is now the owner RECORD, read through
   * `canChatIdAddressProfile`, so an unbound chat resolves to nothing.
   */
  private async runtimeForChat(chatId: string): Promise<ProfileRuntime | undefined> {
    const ownerPaths = this.ownerPaths();
    if (!this.canChatIdAddressProfile(chatId, ownerPaths.profileId)) return undefined;
    return this.resolveRuntimeForProfile(ownerPaths.profileId);
  }

  /**
   * Synchronous twin of `runtimeForChat` for the timer-driven reconcile path (see
   * `ProfileRuntimeManager.getIfBuilt`): never builds, never awaits — `undefined` means
   * "nothing to reconcile right now".
   */
  private runtimeForChatSync(chatId: string): ProfileRuntime | undefined {
    const ownerPaths = this.ownerPaths();
    if (!this.canChatIdAddressProfile(chatId, ownerPaths.profileId)) return undefined;
    if (this.manager) return this.manager.getIfBuilt(ownerPaths.profileId);
    return this.runtime;
  }

  /** Whether `chatId` is a destination this daemon's owner may address. Same authority as
   *  `canChatIdAddressProfile`: the owner record, fail-closed, never a registry. */
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
