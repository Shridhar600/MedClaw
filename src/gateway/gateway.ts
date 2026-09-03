import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from '../config/types';
import { ProfileRegistry } from '../profiles';
import type { ProfileId } from '../profiles';
import type { Channel, IncomingMessage } from '../channels/types';
import { TelegramChannel } from '../channels/telegram';
import { AgentLoop } from '../agent/agent-loop';
import { LLMSemaphore, HeartbeatQueueFullError } from '../tools/semaphore';
import { WriteQueue } from '../profiles';
import { LedgerStore, NarrativeStore, CuriosityQueue } from '../memcore';
import type { LedgerIndexDelta, NarrativeIndexDelta } from '../memcore';
import {
  SqliteFactMirror,
  SqliteEventSink,
  SqliteVecIndex,
  SqliteKeywordIndex,
  SqliteChunkStats,
  SqliteSessionIndex,
} from '../indexstore';
import { deprecatedSessionWarnings } from '../config/deprecations';
import type { CapturePipeline } from '../capture';
import { SqliteStore } from '../memory/sqlite-store';
import type { MemoryIndexer as MemoryIndexerType, MemoryIndexDelta } from '../memory/indexer';
import { createProvider } from '../providers/factory';
import { SessionManager } from './session';
import type * as cron from 'node-cron';
import { HeartbeatScheduler } from '../scheduler/runtime';
import { syncHeartbeatMarkdown } from '../scheduler/heartbeat-markdown';
import type { NightlySweepDeps, NightlySweepResult } from '../scheduler/transcript-sweep-job';
import type { HeartbeatJob } from '../scheduler/types';
import { decideHeartbeatDelivery, HEARTBEAT_NOOP } from '../scheduler/delivery-policy';
import { buildDesiredHeartbeatJobs } from '../scheduler/policy-engine';
import { reconcilePolicyJobs } from '../scheduler/reconciler';
import { OnboardingFlow } from '../onboarding/flow';
import { OnboardingStore } from '../onboarding/store';
import { ensureWorkspaceBootstrap } from '../workspace/bootstrap';
import { checkSystemReadiness, probeChatCompletion } from '../providers/healthcheck';
import type { ReadinessResult } from '../providers/healthcheck';
import type { LLMProvider } from '../providers/types';
import {
  checkProviderBindAddresses,
  verifyWorkspacePermissions,
  summarizeErrorForLog,
} from '../security';
import { EMERGENCY_RESPONSE, isEmergencyInput } from '../safety/emergency-detector';
import { ProfileRuntime } from './runtime';

const UNRECOGNIZED_CHAT_RESPONSE =
  'This chat is not recognized. This is a private health assistant; new chats cannot be added over this channel.';
const PROFILE_UNAVAILABLE_RESPONSE =
  "This chat belongs to a profile this assistant instance can't serve yet.";
// PROD-P1-6: an empty or whitespace-only text message with no media gets a
// short canned reply — no agent run, no session write. Matches the test-cli's
// existing empty-input guard so the dev web UI exercises the same boundary.
const EMPTY_MESSAGE_RESPONSE = "I didn't catch any message. Send some text or an attachment and I'll take a look.";
const SESSION_RESET_FAILURE_RESPONSE = "I couldn't start a fresh session right now. Please try again in a moment.";
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
  private securityWarnings: string[] = [];
  private reconcileTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private semaphore?: LLMSemaphore;
  private stopping = false;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private runtime?: ProfileRuntime;

  constructor(config: AppConfig) {
    this.config = config;
  }

  get runtimeInstance(): ProfileRuntime | undefined {
    return this.runtime;
  }

  get agentLoop(): AgentLoop | undefined {
    return this.runtime?.agentLoop;
  }
  set agentLoop(val: AgentLoop | undefined) {
    this.ensureRuntime().agentLoop = val;
  }

  get sessions(): SessionManager | undefined {
    return this.runtime?.sessions;
  }
  set sessions(val: SessionManager | undefined) {
    this.ensureRuntime().sessions = val;
  }

  get scheduler(): HeartbeatScheduler | undefined {
    return this.runtime?.scheduler;
  }
  set scheduler(val: HeartbeatScheduler | undefined) {
    this.ensureRuntime().scheduler = val;
  }

  get store(): SqliteStore | undefined {
    return this.runtime?.store;
  }
  set store(val: SqliteStore | undefined) {
    this.ensureRuntime().store = val;
  }

  get factMirror(): SqliteFactMirror | undefined {
    return this.runtime?.factMirror;
  }
  set factMirror(val: SqliteFactMirror | undefined) {
    this.ensureRuntime().factMirror = val;
  }

  get eventSink(): SqliteEventSink | undefined {
    return this.runtime?.eventSink;
  }
  set eventSink(val: SqliteEventSink | undefined) {
    this.ensureRuntime().eventSink = val;
  }

  get sessionIndex(): SqliteSessionIndex | undefined {
    return this.runtime?.sessionIndex;
  }
  set sessionIndex(val: SqliteSessionIndex | undefined) {
    this.ensureRuntime().sessionIndex = val;
  }

  get curiosity(): CuriosityQueue | undefined {
    return this.runtime?.curiosity;
  }
  set curiosity(val: CuriosityQueue | undefined) {
    this.ensureRuntime().curiosity = val;
  }

  get ledgerStore(): LedgerStore | undefined {
    return this.runtime?.ledgerStore;
  }
  set ledgerStore(val: LedgerStore | undefined) {
    this.ensureRuntime().ledgerStore = val;
  }

  get sweepTask(): cron.ScheduledTask | undefined {
    return this.runtime?.sweepTask;
  }
  set sweepTask(val: cron.ScheduledTask | undefined) {
    this.ensureRuntime().sweepTask = val;
  }

  get sweepInFlight(): Promise<NightlySweepResult> | undefined {
    return this.runtime?.sweepInFlight;
  }
  set sweepInFlight(val: Promise<NightlySweepResult> | undefined) {
    this.ensureRuntime().sweepInFlight = val;
  }

  get sweepStopping(): boolean {
    return this.runtime?.sweepStopping ?? false;
  }
  set sweepStopping(val: boolean) {
    this.ensureRuntime().sweepStopping = val;
  }

  get sessionSummarySink(): ((chatId: string, anchoredSummary: string) => Promise<void>) | undefined {
    return this.runtime?.sessionSummarySink;
  }
  set sessionSummarySink(val: ((chatId: string, anchoredSummary: string) => Promise<void>) | undefined) {
    this.ensureRuntime().sessionSummarySink = val;
  }

  get promptMode(): 'per-turn' | 'boot-cached' {
    return this.runtime?.promptMode ?? 'boot-cached';
  }
  set promptMode(val: 'per-turn' | 'boot-cached') {
    this.ensureRuntime().promptMode = val;
  }

  get capturePipeline(): CapturePipeline | undefined {
    return this.runtime?.capturePipeline;
  }
  set capturePipeline(val: CapturePipeline | undefined) {
    this.ensureRuntime().capturePipeline = val;
  }

  get indexer(): MemoryIndexerType | undefined {
    return this.runtime?.indexer;
  }
  set indexer(val: MemoryIndexerType | undefined) {
    this.ensureRuntime().indexer = val;
  }

  get writeQueue(): WriteQueue | undefined {
    return this.runtime?.writeQueue;
  }
  set writeQueue(val: WriteQueue | undefined) {
    this.ensureRuntime().writeQueue = val;
  }

  get vectorIndex(): SqliteVecIndex | undefined {
    return this.runtime?.vectorIndex;
  }
  set vectorIndex(val: SqliteVecIndex | undefined) {
    this.ensureRuntime().vectorIndex = val;
  }

  get keywordIndex(): SqliteKeywordIndex | undefined {
    return this.runtime?.keywordIndex;
  }
  set keywordIndex(val: SqliteKeywordIndex | undefined) {
    this.ensureRuntime().keywordIndex = val;
  }

  get chunkStats(): SqliteChunkStats | undefined {
    return this.runtime?.chunkStats;
  }
  set chunkStats(val: SqliteChunkStats | undefined) {
    this.ensureRuntime().chunkStats = val;
  }

  get inFlightOperations(): Set<Promise<unknown>> {
    return this.ensureRuntime().inFlightOperations;
  }

  get backgroundOperations(): Set<Promise<void>> {
    return this.ensureRuntime().backgroundOperations;
  }

  get reindexTails(): Map<string, Promise<void>> {
    return this.ensureRuntime().reindexTails;
  }

  get pendingIndexDeltas(): Map<string, MemoryIndexDelta[]> {
    return this.ensureRuntime().pendingIndexDeltas;
  }

  get dirtyIndexPaths(): Set<string> {
    return this.ensureRuntime().dirtyIndexPaths;
  }

  get dirtyIndexMarkerPath(): string | undefined {
    return this.runtime?.dirtyIndexMarkerPath;
  }
  set dirtyIndexMarkerPath(val: string | undefined) {
    this.ensureRuntime().dirtyIndexMarkerPath = val;
  }

  private ensureRuntime(): ProfileRuntime {
    if (!this.runtime) {
      const profileId = (this.config.profiles?.defaultProfileId ?? 'default') as ProfileId;
      this.runtime = new ProfileRuntime(profileId, this.getEffectiveWorkspace(), this.config);
    }
    return this.runtime;
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

    // Profiles: construct the registry and (idempotently) migrate the legacy
    // single-user workspace into the profile-scoped layout.
    this.profileRegistry = profilesConfig ? this.tryCreateProfileRegistry(profilesConfig.baseDir) : undefined;
    const memoryWorkspace = this.profileRegistry
      ? this.migrateAndResolveWorkspace(this.profileRegistry, profileId, config.memory.workspace)
      : config.memory.workspace;
    this.resolvedMemoryWorkspace = memoryWorkspace;
    const usingProfileWorkspace = memoryWorkspace !== config.memory.workspace;

    const dbPath = usingProfileWorkspace && this.profileRegistry
      ? this.profileRegistry.profileSearchDb(profileId)
      : path.join(config.memory.workspace, '..', 'search.db');

    const sessionsPath = this.profileRegistry
      ? (usingProfileWorkspace
        ? this.profileRegistry.profileSessions(profileId)
        : path.join(path.dirname(config.memory.workspace), 'sessions'))
      : undefined;

    const mainProvider = createProvider(config.providers.main);
    this.mainProvider = mainProvider;

    const semaphore = new LLMSemaphore();
    this.semaphore = semaphore;

    // Channel
    if (config.channels.telegram.enabled) {
      const token = config.channels.telegram.botToken || process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        throw new Error('TELEGRAM_BOT_TOKEN not set. Set it in config or environment.');
      }
      this.channel = new TelegramChannel(token, memoryWorkspace);
      this.channel.onMessage((msg) => this.handleMessage(msg));
      await this.channel.connect();
    }

    const schedulerPaths = this.resolveSchedulerPaths(profileId);

    // ProfileRuntime constructs and owns the per-profile stack
    this.runtime = await ProfileRuntime.create({
      profileId,
      workspace: memoryWorkspace,
      dbPath,
      sessionsPath,
      schedulerPaths,
      config,
      mainProvider,
      semaphore,
      // Match the original initializeScheduler guard: the scheduler starts only when a delivery
      // channel exists (heartbeats deliver through it). Telegram-disabled ⇒ no channel ⇒ no scheduler.
      canSchedule: Boolean(config.heartbeat.enabled && this.channel),
      runScheduledJob: (job) => this.handleScheduledJob(job, true),
      sideEffectLookup: (entity) => {
        let sideEffectProvider: LLMProvider = mainProvider;
        try {
          sideEffectProvider = createProvider(config.providers.medical);
        } catch (e) {
          console.warn('[gateway] Medical provider for side-effect lookup unavailable; using main:', summarizeErrorForLog(e));
        }
        return this.lookupSideEffects(sideEffectProvider, entity);
      },
    });

    if (this.runtime.scheduler) {
      const startupChatId = await this.resolveStartupPolicyChatId();
      if (startupChatId) {
        await this.reconcileHeartbeatPolicies(startupChatId);
      }
      await syncHeartbeatMarkdown(this.getEffectiveWorkspace(), await this.runtime.scheduler.listJobs());
    }

    await this.runBootHealthchecks();
    this.runSecurityChecks();

    console.log('[gateway] Redacted is running.');
  }

  async runTranscriptSweep(): Promise<NightlySweepResult> {
    if (this.stopping) return { scanned: false, added: 0 };
    if (!this.runtime) return { scanned: false, added: 0 };
    return this.runtime.runTranscriptSweep();
  }

  private launchBackgroundSweep(): void {
    if (this.stopping) return;
    this.runtime?.launchBackgroundSweep();
  }

  private buildSweepDeps(): NightlySweepDeps {
    return this.ensureRuntime().buildSweepDeps();
  }

  private async captureUserTurn(chatId: string, text: string, sourceMessageId?: string): Promise<void> {
    const pipeline = this.runtime?.capturePipeline;
    if (!pipeline || text.trim().length === 0) return;
    try {
      await pipeline.ingest({
        profileId: (this.getProfileForChat(chatId) ?? 'default') as string,
        source: 'chat',
        kind: 'narrative-note',
        payload: { text },
        ...(sourceMessageId ? { idempotencyKey: `chat:${chatId}:${sourceMessageId}` } : {}),
      });
    } catch (e) {
      console.warn('[gateway] per-turn narrative capture failed (continuing):', summarizeErrorForLog(e));
    }
  }

  private async persistFailureTrace(chatId: string, userContent: string, fallback: string): Promise<void> {
    try {
      await this.runtime?.sessions?.recordTurn(chatId, [
        { role: 'user', content: userContent },
        { role: 'assistant', content: fallback },
      ]);
    } catch (e) {
      console.error('[gateway] Failed to persist agent failure trace (continuing):', summarizeErrorForLog(e));
    }
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
    return this.trackOperation(() => this.handleTestMessageInternal(chatId, text, sourceMessageId));
  }

  private async handleTestMessageInternal(chatId: string, text: string, sourceMessageId?: string): Promise<string> {
    if (text.trim().length === 0) {
      return EMPTY_MESSAGE_RESPONSE;
    }

    const profileId = this.getProfileForChat(chatId);
    if (profileId === null) {
      const emergency = this.handleEmergencyInput(text);
      return emergency ?? UNRECOGNIZED_CHAT_RESPONSE;
    }
    if (!this.isDefaultRuntimeProfile(profileId)) {
      const emergency = this.handleEmergencyInput(text);
      return emergency ?? PROFILE_UNAVAILABLE_RESPONSE;
    }

    if (text.trim() === '/status') {
      return this.buildBootStatusText();
    }

    if (text.trim() === '/new') {
      try {
        await this.runtime!.sessions!.resetSession(chatId);
      } catch (e) {
        console.error('[gateway] Failed to reset session (keeping existing context):', summarizeErrorForLog(e));
        return SESSION_RESET_FAILURE_RESPONSE;
      }
      return 'Starting fresh session. Your health memory is preserved.';
    }

    if (text.trim() === '/compact') {
      await this.runtime!.sessions!.runCompaction(chatId);
      return 'Compacted the conversation. Older turns are summarized; recent context is kept. Nothing is lost — ask me to look anything up.';
    }

    const emergency = this.handleEmergencyInput(text);
    if (emergency) {
      try {
        await this.runtime?.sessions?.recordTurn(chatId, [
          { role: 'user', content: text },
          { role: 'assistant', content: emergency },
        ]);
      } catch (e) {
        console.error('[gateway] Failed to persist emergency turn (test path; sending guidance anyway):', summarizeErrorForLog(e));
      }
      this.scheduleBackgroundCapture(chatId, text, sourceMessageId);
      return emergency;
    }

    const onboarding = await this.handleOnboarding(chatId, text);
    if (onboarding) {
      await this.captureUserTurn(chatId, text, sourceMessageId);
      return onboarding;
    }

    await this.captureUserTurn(chatId, text, sourceMessageId);

    let result: Awaited<ReturnType<AgentLoop['run']>>;
    try {
      const history = await this.runtime!.sessions!.prepareHistory(chatId);
      result = await this.runtime!.agentLoop!.run(text, history, { chatId, mode: 'chat' });
    } catch (e) {
      console.error('[gateway] Agent error (test path):', summarizeErrorForLog(e));
      await this.persistFailureTrace(chatId, text, "I'm having trouble right now. Please try again in a moment.");
      return "I'm having trouble right now. Please try again in a moment.";
    }

    try {
      await this.runtime!.sessions!.recordTurn(chatId, [
        { role: 'user', content: text },
        ...result.trace,
      ]);
      await this.runtime!.sessions!.recordPromptUsage(chatId, result.lastPromptTokens);
    } catch (e) {
      console.error('[gateway] Post-agent persistence error (test path; returning answer anyway):', summarizeErrorForLog(e));
    }
    await this.debouncedReconcile(chatId);
    return result.text;
  }

  private async handleMessage(incoming: IncomingMessage): Promise<void> {
    if (this.stopping) return;
    try {
      await this.trackOperation(() => this.handleMessageInternal(incoming));
    } catch (error) {
      console.error('[gateway] Handler error:', summarizeErrorForLog(error));
    }
  }

  private async handleMessageInternal(incoming: IncomingMessage): Promise<void> {
    const { chatId, text } = incoming;
    console.log(
      `[gateway] Message from ${chatId}: ${text.length} chars${incoming.mediaPath ? ', media attached' : ''}`,
    );

    // PROD-P1-6: empty/whitespace-only text with no media → short canned reply,
    // no agent run, no session write. A media upload with empty caption still
    // flows through the normal agent path below.
    if (text.trim().length === 0 && !incoming.mediaPath && !incoming.mediaError) {
      try {
        await this.channel!.send(chatId, { text: EMPTY_MESSAGE_RESPONSE });
      } catch (e) {
        console.error('[gateway] Failed to send empty-message response:', summarizeErrorForLog(e));
      }
      return;
    }

    const profileId = this.getProfileForChat(chatId);
    if (profileId === null) {
      // Refused chats still get emergency guidance (medical-safety rule; the
      // emergency text carries no PHI) — but no agent run, no session write.
      const emergency = this.handleEmergencyInput(text);
      try {
        await this.channel!.send(chatId, { text: emergency ?? UNRECOGNIZED_CHAT_RESPONSE });
      } catch (e) {
        console.error('[gateway] Failed to respond to unrecognized chat:', summarizeErrorForLog(e));
      }
      return;
    }
    if (!this.isDefaultRuntimeProfile(profileId)) {
      // C-01 interim: never dispatch a non-default profile into this default-bound pipeline.
      const emergency = this.handleEmergencyInput(text);
      try {
        await this.channel!.send(chatId, { text: emergency ?? PROFILE_UNAVAILABLE_RESPONSE });
      } catch (e) {
        console.error('[gateway] Failed to respond to unavailable profile chat:', summarizeErrorForLog(e));
      }
      return;
    }

    if (text.trim() === '/status') {
      const statusText = this.buildBootStatusText();
      await this.channel!.send(chatId, { text: statusText });
      return;
    }

    const agentInput = this.buildAgentInput(incoming);

    // Handle /new command
    if (text.trim() === '/new') {
      try {
        await this.runtime!.sessions!.resetSession(chatId);
      } catch (e) {
        console.error('[gateway] Failed to reset session (keeping existing context):', summarizeErrorForLog(e));
        try {
          await this.channel!.send(chatId, { text: SESSION_RESET_FAILURE_RESPONSE });
        } catch (sendError) {
          console.error('[gateway] Failed to send session-reset failure response:', summarizeErrorForLog(sendError));
        }
        return;
      }
      await this.channel!.send(chatId, { text: 'Starting fresh session. Your health memory is preserved.' });
      return;
    }

    // P2b DD9: /compact forces the spec-14 §4 compaction pipeline on demand.
    if (text.trim() === '/compact') {
      await this.runtime!.sessions!.runCompaction(chatId);
      await this.channel!.send(chatId, { text: 'Compacted the conversation. Older turns are summarized; recent context is kept. Nothing is lost — ask me to look anything up.' });
      return;
    }

    const emergency = this.handleEmergencyInput(text);
    if (emergency) {
      // Persist-first (RES-P0-4): record the turn BEFORE sending so a crash
      // between the two never loses the turn. The emergency text is canned
      // and carries no PHI, but ordering still matters for transcript
      // integrity. On persistence failure we still send the guidance —
      // medical-safety prioritizes reaching the user over disk hygiene
      // (divergence is logged, sanitized). On send failure we just log;
      // the (possibly persisted) turn is not double-sent.
      const emergencyTurn = [
        { role: 'user' as const, content: agentInput },
        { role: 'assistant' as const, content: emergency },
      ];
      try {
        await this.runtime?.sessions?.recordTurn(chatId, emergencyTurn);
      } catch (e) {
        console.error(
          '[gateway] Failed to persist emergency turn (sending guidance anyway):',
          summarizeErrorForLog(e),
        );
      }
      try {
        await this.channel!.send(chatId, { text: emergency });
      } catch (e) {
        console.error('[gateway] Failed to send emergency response:', summarizeErrorForLog(e));
      }
      // The emergency response is independent of the capture/index projection. Start
      // capture only after delivery and never make the user wait for it.
      this.scheduleBackgroundCapture(chatId, text, incoming.messageId);
      return;
    }

    if (incoming.mediaError) {
      // M-3 / F4 parity: this was the one branch that skipped lossless capture. Capture the raw
      // caption first (no-ops on an empty caption) so a failed upload never loses the user's words.
      await this.captureUserTurn(chatId, text, incoming.messageId);
      const failureTrace = [
        { role: 'user' as const, content: agentInput },
        { role: 'assistant' as const, content: `[Media upload failure]\n${incoming.mediaError}` },
      ];

      try {
        await this.runtime!.sessions!.recordTurn(chatId, failureTrace);
      } catch (e) {
        console.error('[gateway] Failed to persist media upload error turn:', summarizeErrorForLog(e));
      }

      try {
        await this.channel!.send(chatId, { text: incoming.mediaError });
      } catch (e) {
        console.error('[gateway] Failed to send media upload error:', summarizeErrorForLog(e));
      }
      return;
    }

    const onboarding = await this.handleOnboarding(chatId, text);
    if (onboarding) {
      // CAP (M6-sec): parity with handleTestMessage — capture before the return.
      await this.captureUserTurn(chatId, text, incoming.messageId);
      await this.channel!.send(chatId, { text: onboarding });
      return;
    }

    // Emergency check after onboarding completes
    const postOnboardingEmergency = this.handleEmergencyInput(text);
    if (postOnboardingEmergency) {
      // Persist-first (RES-P0-4), mirroring the early emergency branch above.
      try {
        await this.runtime?.sessions?.recordTurn(chatId, [
          { role: 'user', content: agentInput },
          { role: 'assistant', content: postOnboardingEmergency },
        ]);
      } catch (e) {
        console.error(
          '[gateway] Failed to persist emergency turn (sending guidance anyway):',
          summarizeErrorForLog(e),
        );
      }
      try {
        await this.channel!.send(chatId, { text: postOnboardingEmergency });
      } catch (e) {
        console.error('[gateway] Failed to send emergency response:', summarizeErrorForLog(e));
      }
      this.scheduleBackgroundCapture(chatId, text, incoming.messageId);
      return;
    }

    // Lossless per-turn capture (F4) — the RAW user text, always, before the agent run.
    await this.captureUserTurn(chatId, text, incoming.messageId);

    let result: Awaited<ReturnType<AgentLoop['run']>>;
    try {
      const history = await this.runtime!.sessions!.prepareHistory(chatId);
      result = await this.runtime!.agentLoop!.run(agentInput, history, { chatId, mode: 'chat' });
    } catch (e) {
      console.error('[gateway] Agent error:', summarizeErrorForLog(e));
      await this.persistFailureTrace(chatId, agentInput, "I'm having trouble right now. Please try again in a moment.");
      try {
        await this.channel!.send(chatId, { text: "I'm having trouble right now. Please try again in a moment." });
      } catch (fallbackError) {
        console.error('[gateway] Failed to send fallback response:', summarizeErrorForLog(fallbackError));
      }
      return;
    }

    // Persist-first (RES-P0-4): record the turn BEFORE sending so a crash
    // between the agent run and the channel write never loses the turn the
    // user is about to read. Contract decision: if persistence fails we STILL
    // send the real response (UX wins; the divergence is logged sanitized) —
    // losing an expensive LLM response is worse than a logged disk divergence.
    let persistFailed = false;
    try {
      await this.runtime!.sessions!.recordTurn(chatId, [
        { role: 'user', content: agentInput },
        ...result.trace,
      ]);
      // Spec 14 §3: feed the real window-fill signal back so the NEXT turn's prepareHistory can trigger.
      await this.runtime!.sessions!.recordPromptUsage(chatId, result.lastPromptTokens);
    } catch (e) {
      persistFailed = true;
      console.error(
        '[gateway] Pre-send persistence error (sending response anyway; logged divergence):',
        summarizeErrorForLog(e),
      );
    }

    try {
      await this.channel!.send(chatId, { text: result.text });
    } catch (e) {
      console.error('[gateway] Send error:', summarizeErrorForLog(e));
      try {
        await this.channel!.send(chatId, { text: "I'm having trouble right now. Please try again in a moment." });
      } catch (fallbackError) {
        console.error('[gateway] Failed to send fallback response:', summarizeErrorForLog(fallbackError));
      }
      return;
    }

    if (!persistFailed) {
      try {
        await this.debouncedReconcile(chatId);
      } catch (e) {
        console.error('[gateway] Reconciliation error:', summarizeErrorForLog(e));
      }
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
      await this.runtime?.drainAndClose();
    } catch (error) {
      firstError = firstError ?? error;
    }

    console.log('[gateway] Stopped.');
    if (firstError) {
      throw firstError;
    }
  }

  private async initializeScheduler(): Promise<void> {
    if (!this.config.heartbeat.enabled) {
      return;
    }
    if (!this.channel || !this.agentLoop || !this.sessions) {
      return;
    }
    this.ensureRuntime();
    if (!this.runtime!.scheduler) {
      await this.runtime!.initializeScheduler({
        schedulerPaths: this.resolveSchedulerPaths(this.runtime!.profileId),
        runScheduledJob: (job) => this.handleScheduledJob(job, true),
      });
    }
    if (this.runtime!.scheduler) {
      const startupChatId = await this.resolveStartupPolicyChatId();
      if (startupChatId) {
        await this.reconcileHeartbeatPolicies(startupChatId);
      }
      await syncHeartbeatMarkdown(this.getEffectiveWorkspace(), await this.runtime!.scheduler.listJobs());
    }
  }

  private async handleScheduledJob(job: HeartbeatJob, invokedByScheduler = false): Promise<void> {
    if (this.stopping) return;
    const profileId = this.getProfileForChat(job.chatId);
    if (profileId === null || !this.isDefaultRuntimeProfile(profileId)) {
      console.warn(`[gateway] Skipping heartbeat job ${job.id}: chat is not available in this runtime.`);
      return;
    }
    const decision = decideHeartbeatDelivery(job, {
      now: new Date(Date.now()),
      quietHours: this.config.heartbeat.policy.quietHours,
      lastChatActivityAt: this.runtime!.sessions!.getLastActiveAt(job.chatId),
      skipIfChatActiveWithinMinutes: this.config.heartbeat.policy.skipIfChatActiveWithinMinutes,
    });
    if (decision.action === 'skip') {
      await this.runtime?.scheduler?.recordOutcome(job.id, decision.reason);
      return;
    }

    const history = await this.runtime!.sessions!.prepareHistory(job.chatId);
    if (this.stopping) return;
    const input = [
      '[Heartbeat Trigger]',
      `Job id: ${job.id}`,
      `Job title: ${job.title}`,
      `Prompt: ${job.prompt}`,
    ].join('\n');

    try {
      const result = await this.runtime!.agentLoop!.run(input, history, { chatId: job.chatId, origin: 'heartbeat', mode: 'heartbeat' });
      if (result.text === HEARTBEAT_NOOP) {
        await this.runtime!.sessions!.recordTurn(job.chatId, [
          { role: 'user', content: input },
          ...result.trace,
        ], 'heartbeat');
        try {
          await this.runtime!.sessions!.recordPromptUsage(job.chatId, result.lastPromptTokens);
        } catch (e) {
          console.warn('[gateway] Failed to persist heartbeat prompt usage; continuing to delivery:', summarizeErrorForLog(e));
        }
        await this.runtime?.scheduler?.recordOutcome(job.id, 'noop');
        await this.reconcileAfterScheduledDelivery(job.chatId);
        return;
      }

      await this.runtime!.sessions!.recordTurn(job.chatId, [
        { role: 'user', content: input },
        ...result.trace,
      ], 'heartbeat');
      try {
        await this.runtime!.sessions!.recordPromptUsage(job.chatId, result.lastPromptTokens);
      } catch (e) {
        console.warn('[gateway] Failed to persist heartbeat prompt usage; continuing to delivery:', summarizeErrorForLog(e));
      }
      await this.channel!.send(job.chatId, { text: result.text });
      await this.runtime?.scheduler?.recordOutcome(job.id, 'sent');
      await this.reconcileAfterScheduledDelivery(job.chatId);
    } catch (error) {
      if (error instanceof HeartbeatQueueFullError) {
        console.warn(`[gateway] Heartbeat queue full for job ${job.id}; scheduler will retry.`);
        try {
          await this.runtime?.scheduler?.recordFailure(job.id, 'heartbeat queue full');
        } catch (recordError) {
          console.warn(
            `[gateway] Failed to record queue-full for job ${job.id}:`,
            summarizeErrorForLog(recordError),
          );
        }
        return;
      }

      if (!invokedByScheduler) {
        try {
          await this.runtime?.scheduler?.recordFailure(job.id, summarizeErrorForLog(error));
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

  private async reconcileHeartbeatPolicies(chatId: string): Promise<void> {
    if (this.stopping || !this.runtime?.scheduler) {
      return;
    }
    const resolved = this.profileRegistry?.getProfileForChat(chatId);
    if (resolved && !this.isDefaultRuntimeProfile(resolved.profileId)) {
      return;
    }

    const desired = await buildDesiredHeartbeatJobs({
      workspacePath: this.getEffectiveWorkspace(),
      chatId,
      timezone: this.config.heartbeat.timezone,
      policy: this.config.heartbeat.policy,
    });
    await reconcilePolicyJobs(this.runtime.scheduler, desired);
    await syncHeartbeatMarkdown(this.getEffectiveWorkspace(), await this.runtime.scheduler.listJobs());
  }

  private async debouncedReconcile(chatId: string): Promise<void> {
    if (this.stopping || !this.runtime?.scheduler) {
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

  private async resolveStartupPolicyChatId(): Promise<string | undefined> {
    const sessionChatId = this.runtime?.sessions?.getMostRecentChatId();
    if (sessionChatId && this.isDefaultRuntimeChat(sessionChatId)) {
      return sessionChatId;
    }

    const jobs = await this.runtime!.scheduler!.listJobs();
    return jobs.find((job) => job.chatId !== '__startup__' && this.isDefaultRuntimeChat(job.chatId))?.chatId;
  }

  private buildAgentInput(incoming: IncomingMessage): string {
    const parts: string[] = [incoming.text];
    if (incoming.mediaPath) {
      parts.push('', `Uploaded media path (relative to workspace): ${incoming.mediaPath}`);
    }
    if (incoming.replyToMessageId) {
      parts.push('', `Reply to message id: ${incoming.replyToMessageId}`);
    }
    if (incoming.userId) {
      parts.push('', `User id: ${incoming.userId}`);
    }
    return parts.join('\n');
  }

  private async handleOnboarding(chatId: string, input: string): Promise<string | undefined> {
    const workspace = this.getEffectiveWorkspace();
    if (input.trim() === '/onboarding restart' || input.trim() === '/profile update') {
      const flow = new OnboardingFlow(
        new OnboardingStore(workspace),
        workspace,
        this.config.heartbeat.timezone,
        this.config.emergency?.keywords,
      );
      const result = await flow.handle('restart onboarding');
      try {
        await this.runtime?.sessions?.recordTurn(chatId, [
          { role: 'user', content: input },
          { role: 'assistant', content: result.response },
        ]);
      } catch (e) {
        console.error('[gateway] Failed to persist onboarding turn (returning response anyway):', summarizeErrorForLog(e));
      }
      return result.response;
    }

    const store = new OnboardingStore(workspace);
    const flow = new OnboardingFlow(store, workspace, this.config.heartbeat.timezone, this.config.emergency?.keywords);
    if (await flow.isComplete()) {
      return undefined;
    }

    const result = await flow.handle(input);
    if (!result.response) {
      return undefined;
    }
    try {
      await this.runtime?.sessions?.recordTurn(chatId, [
        { role: 'user', content: input },
        { role: 'assistant', content: result.response },
      ]);
    } catch (e) {
      console.error('[gateway] Failed to persist onboarding turn (returning response anyway):', summarizeErrorForLog(e));
    }
    return result.response;
  }

  private handleEmergencyInput(input: string): string | undefined {
    const cleanInput = input
      .split(/\r?\n/)
      .filter((line) => !/^\s*(user id|reply to message id|uploaded media path)\s*:/i.test(line))
      .join('\n');
    if (!isEmergencyInput(cleanInput, this.config.emergency?.keywords)) {
      return undefined;
    }
    return EMERGENCY_RESPONSE;
  }

  private scheduleBackgroundCapture(chatId: string, text: string, sourceMessageId?: string): void {
    this.trackBackgroundOperation('emergency capture', () => this.captureUserTurn(chatId, text, sourceMessageId));
  }

  private launchBackgroundReconcile(chatId: string): void {
    if (this.stopping) return;
    this.trackBackgroundOperation('heartbeat reconciliation', () => this.reconcileHeartbeatPolicies(chatId));
  }

  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.runtime) {
      return this.runtime.trackOperation(operation);
    }
    return Promise.resolve().then(operation);
  }

  private trackBackgroundOperation(label: string, operation: () => Promise<void>): void {
    if (this.stopping) return;
    this.ensureRuntime().trackBackgroundOperation(label, operation);
  }

  private queueBackgroundReindex(relativePath: string, operation: () => Promise<void>): void {
    this.ensureRuntime().queueBackgroundReindex(relativePath, operation);
  }

  private narrativeDeltaFor(relativePath: string, narrativeStore: NarrativeStore): NarrativeIndexDelta | undefined {
    return this.ensureRuntime().narrativeDeltaFor(relativePath, narrativeStore);
  }

  private enqueuePendingIndexDelta(
    relativePath: string,
    sourceDelta: LedgerIndexDelta | NarrativeIndexDelta,
  ): void {
    this.ensureRuntime().enqueuePendingIndexDelta(relativePath, sourceDelta);
  }

  private takePendingIndexDelta(relativePath: string): MemoryIndexDelta | undefined {
    return this.runtime?.takePendingIndexDelta(relativePath);
  }

  private async drainInFlightOperations(): Promise<void> {
    await this.runtime?.drainInFlightOperations();
  }

  private async drainBackgroundOperations(): Promise<void> {
    await this.runtime?.drainBackgroundOperations();
  }

  private async markIndexDirty(
    workspace: string,
    relativePath: string,
    store: SqliteStore,
    sourceHash?: string,
  ): Promise<void> {
    await this.ensureRuntime().markIndexDirty(workspace, relativePath, store, sourceHash);
  }

  private async hashFile(filePath: string): Promise<string> {
    return this.ensureRuntime().hashFile(filePath);
  }

  private clearIndexDirty(relativePath: string): void {
    this.runtime?.clearIndexDirty(relativePath);
  }

  private clearAllDirtyIndexMarkers(): void {
    this.runtime?.clearAllDirtyIndexMarkers();
  }

  private persistDirtyIndexMarker(): void {
    this.runtime?.persistDirtyIndexMarker();
  }

  private closeStore(): void {
    this.runtime?.closeStore();
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
    const lines = [
      `System Health${pending ? ' (health-check-pending)' : ''}:`,
      ...h.providers.map((p) => `  ${p.label}: ${readinessLabel(p)}`),
      `  telegram: ${readinessLabel(h.telegram)}`,
      `  prompt: ${this.promptMode}${this.promptMode === 'boot-cached' ? ' (recall off — degraded)' : ''}`,
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

  private getProfileForChat(chatId: string): ProfileId | null {
    if (!this.profileRegistry) {
      return (this.config.profiles?.defaultProfileId ?? 'default') as ProfileId;
    }
    const existing = this.profileRegistry.getProfileForChat(chatId);
    if (existing) {
      return existing.profileId;
    }
    const anyChatPaired = this.profileRegistry.getAllProfiles().some((p) => p.chatIds.length > 0);
    if (anyChatPaired) {
      console.warn(`[gateway] Refused unrecognized chat ${chatId} (auto-pair closed after first pairing)`);
      return null;
    }
    const defaultProfile = this.profileRegistry.getOrCreateDefaultProfile();
    this.profileRegistry.pairChatToProfile(chatId, defaultProfile.profileId);
    console.log(`[gateway] Paired chat ${chatId} to profile "${defaultProfile.profileId}" (first-contact auto-pair)`);
    return defaultProfile.profileId;
  }

  private isDefaultRuntimeProfile(profileId: ProfileId): boolean {
    return profileId === (this.config.profiles?.defaultProfileId ?? 'default');
  }

  private isDefaultRuntimeChat(chatId: string): boolean {
    const resolved = this.profileRegistry?.getProfileForChat(chatId);
    return !resolved || this.isDefaultRuntimeProfile(resolved.profileId);
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
