import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from '../config/types';
import { ProfileRegistry } from '../profiles';
import type { ProfileId } from '../profiles';
import type { Channel, IncomingMessage } from '../channels/types';
import { TelegramChannel } from '../channels/telegram';
import { AgentLoop } from '../agent/agent-loop';
import { ContextAssembler } from '../agent/context';
import { MemoryEngine } from '../memory/memory-engine';
import { ToolRegistry } from '../tools/registry';
import { LLMSemaphore, HeartbeatQueueFullError } from '../tools/semaphore';
import { createMemoryTools } from '../tools/memory-tools';
import { createMedicalTools } from '../tools/medical-tools';
import { createCronManageTool } from '../tools/cron-manage';
import { createHeartbeatManageTool } from '../tools/heartbeat-manage';
import { SqliteStore } from '../memory/sqlite-store';
import { MemorySearch } from '../memory/search';
import { createProvider } from '../providers/factory';
import { SessionManager } from './session';
import { HeartbeatStore } from '../scheduler/store';
import { HeartbeatScheduler } from '../scheduler/runtime';
import { syncHeartbeatMarkdown } from '../scheduler/heartbeat-markdown';
import type { HeartbeatJob } from '../scheduler/types';
import { decideHeartbeatDelivery, HEARTBEAT_NOOP } from '../scheduler/delivery-policy';
import { buildDesiredHeartbeatJobs } from '../scheduler/policy-engine';
import { reconcilePolicyJobs } from '../scheduler/reconciler';
import { OnboardingFlow } from '../onboarding/flow';
import { OnboardingStore } from '../onboarding/store';
import { ensureWorkspaceBootstrap } from '../workspace/bootstrap';
import { checkSystemReadiness } from '../providers/healthcheck';
import type { ReadinessResult } from '../providers/healthcheck';
import { checkProviderBindAddresses, verifyWorkspacePermissions, summarizeErrorForLog } from '../security';

const EMERGENCY_PATTERN =
  /\b(chest pain|can't breathe|cannot breathe|difficulty breathing|stroke|heart attack|severe bleeding|suicidal|emergency)\b/i;
const EMERGENCY_RESPONSE =
  'This may be an emergency. Please contact local emergency services now or go to the nearest emergency department. If you can, ask someone nearby to stay with you while you get help.';
const UNRECOGNIZED_CHAT_RESPONSE =
  'This chat is not recognized. This is a private health assistant; new chats cannot be added over this channel.';

export class Gateway {
  private config: AppConfig;
  private channel?: Channel;
  private agentLoop?: AgentLoop;
  private sessions?: SessionManager;
  private scheduler?: HeartbeatScheduler;
  private store?: SqliteStore;
  private profileRegistry?: ProfileRegistry;
  private resolvedMemoryWorkspace?: string;
  private bootHealth?: { providers: ReadinessResult[]; telegram: ReadinessResult };
  private securityWarnings: string[] = [];
  private reconcileTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(config: AppConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const { config } = this;
    const profilesConfig = config.profiles;
    const profileId = (profilesConfig?.defaultProfileId ?? 'default') as ProfileId;

    console.log('[gateway] Starting Redacted...');

    // Bootstrap workspace with template files on first run
    this.bootstrapWorkspace(config.memory.workspace);

    // Profiles: construct the registry and (idempotently) migrate the legacy
    // single-user workspace into the profile-scoped layout. Only attempted
    // when the caller has actually configured a `profiles` section — configs
    // that omit it (older configs, ad-hoc test configs) keep the pre-P0
    // legacy paths untouched, which is the safest "sensible default" per the
    // resilience rule (never assume a filesystem location the caller didn't
    // opt into). This step must never crash boot: any failure here falls
    // back to the legacy workspace path.
    this.profileRegistry = profilesConfig ? this.tryCreateProfileRegistry(profilesConfig.baseDir) : undefined;
    const memoryWorkspace = this.profileRegistry
      ? this.migrateAndResolveWorkspace(this.profileRegistry, profileId, config.memory.workspace)
      : config.memory.workspace;
    this.resolvedMemoryWorkspace = memoryWorkspace;
    const usingProfileWorkspace = memoryWorkspace !== config.memory.workspace;

    // Memory
    const memory = new MemoryEngine(memoryWorkspace, profileId);
    const dbPath = usingProfileWorkspace && this.profileRegistry
      ? this.profileRegistry.profileSearchDb(profileId)
      : path.join(config.memory.workspace, '..', 'search.db');
    // SqliteStore (better-sqlite3) does not create its parent directory;
    // the legacy path relied on config.memory.workspace's parent already
    // existing via bootstrapWorkspace. The profile-scoped `.state/` dir has
    // no other creator this early in startup, so ensure it here.
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const store = new SqliteStore(dbPath, profileId);
    this.store = store;
    const embeddingProvider = createProvider(config.providers.embeddings);
    const { MemoryIndexer } = await import('../memory/indexer');
    const indexer = new MemoryIndexer(store, embeddingProvider, memoryWorkspace, profileId);
    try {
      await indexer.indexAll();
      console.log('[gateway] Memory index ready');
    } catch (error) {
      console.warn('[gateway] Memory index unavailable; continuing with degraded search:', summarizeErrorForLog(error));
    }

    const search = new MemorySearch(store, embeddingProvider, config.memory.search.hybridWeights, profileId);

    // Providers
    const mainProvider = createProvider(config.providers.main);

    // Tools
    const registry = new ToolRegistry(config.tools);
    for (const tool of createMemoryTools(memory, search, indexer, profileId)) {
      registry.register(tool);
    }

    // Medical tools with medical provider
    const medicalProvider = createProvider(config.providers.medical);
    for (const tool of createMedicalTools(memory, search, medicalProvider, mainProvider, memoryWorkspace, {
      medicalProviderType: config.providers.medical.type,
      medicalProviderBaseUrl: config.providers.medical.baseUrl,
      allowRawMedicalMedia: config.providers.medical.allowRawMedicalMedia,
      mainProviderType: config.providers.main.type,
      mainProviderBaseUrl: config.providers.main.baseUrl,
    })) {
      registry.register(tool);
    }

    // Context
    const assembler = new ContextAssembler(memory, config.memory.bootstrapMaxChars, profileId);
    const systemMessages = await assembler.buildSystemMessages();

    // Agent
    const semaphore = new LLMSemaphore();
    this.agentLoop = new AgentLoop(mainProvider, registry, systemMessages, config.agent, semaphore);

    // Sessions
    // Path resolution stays here (Gateway) rather than inside SessionManager
    // itself: SessionManager has no other dependency on the profiles module,
    // and keeping it that way avoids adding module coupling for a value the
    // caller already has to compute (ProfileRegistry.profileSessions). Only
    // derived when a profiles config was actually supplied; otherwise
    // SessionManager keeps its own legacy default.
    const sessionsPath = this.profileRegistry ? this.profileRegistry.profileSessions(profileId) : undefined;
    this.sessions = new SessionManager(
      config.sessions.softResetAfterMinutes,
      config.sessions.hardResetAfterMinutes,
      sessionsPath,
      mainProvider,
      registry,
      config.sessions.compaction,
      profileId,
    );

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

    await this.initializeScheduler();
    if (this.scheduler) {
      registry.register(createCronManageTool(this.scheduler, this.getEffectiveWorkspace()));
      registry.register(createHeartbeatManageTool(this.scheduler, this.getEffectiveWorkspace()));
    }

    await this.runBootHealthchecks();
    this.runSecurityChecks();

    console.log('[gateway] Redacted is running.');
  }

  async handleTestMessage(chatId: string, text: string): Promise<string> {
    const profileId = this.getProfileForChat(chatId);
    if (profileId === null) {
      // Refused chats still get emergency guidance (medical-safety rule; the
      // emergency text carries no PHI) — but no agent run, no session write.
      const emergency = this.handleEmergencyInput(text);
      return emergency ?? UNRECOGNIZED_CHAT_RESPONSE;
    }

    if (text.trim() === '/status') {
      return this.buildBootStatusText();
    }

    const emergency = this.handleEmergencyInput(text);
    if (emergency) {
      await this.sessions?.recordTurn(chatId, [
        { role: 'user', content: text },
        { role: 'assistant', content: emergency },
      ]);
      return emergency;
    }

    const onboarding = await this.handleOnboarding(chatId, text);
    if (onboarding) {
      return onboarding;
    }

    const history = await this.sessions!.prepareHistory(chatId);
    const result = await this.agentLoop!.run(text, history, { chatId });
    await this.sessions!.recordTurn(chatId, [
      { role: 'user', content: text },
      ...result.trace,
    ]);
    await this.debouncedReconcile(chatId);
    return result.text;
  }

  private async handleMessage(incoming: IncomingMessage): Promise<void> {
    const { chatId, text } = incoming;
    console.log(
      `[gateway] Message from ${chatId}: ${text.length} chars${incoming.mediaPath ? ', media attached' : ''}`,
    );

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

    if (text.trim() === '/status') {
      const statusText = this.buildBootStatusText();
      await this.channel!.send(chatId, { text: statusText });
      return;
    }

    const agentInput = this.buildAgentInput(incoming);

    // Handle /new command
    if (text.trim() === '/new') {
      await this.sessions!.resetSession(chatId);
      await this.channel!.send(chatId, { text: 'Starting fresh session. Your health memory is preserved.' });
      return;
    }

    const emergency = this.handleEmergencyInput(text);
    if (emergency) {
      try {
        await this.channel!.send(chatId, { text: emergency });
      } catch (e) {
        console.error('[gateway] Failed to send emergency response:', summarizeErrorForLog(e));
        return;
      }
      try {
        await this.sessions!.recordTurn(chatId, [
          { role: 'user', content: agentInput },
          { role: 'assistant', content: emergency },
        ]);
      } catch (e) {
        console.error('[gateway] Failed to persist emergency turn:', summarizeErrorForLog(e));
      }
      return;
    }

    if (incoming.mediaError) {
      const failureTrace = [
        { role: 'user' as const, content: agentInput },
        { role: 'assistant' as const, content: `[Media upload failure]\n${incoming.mediaError}` },
      ];

      try {
        await this.channel!.send(chatId, { text: incoming.mediaError });
      } catch (e) {
        console.error('[gateway] Failed to send media upload error:', summarizeErrorForLog(e));
        return;
      }

      try {
        await this.sessions!.recordTurn(chatId, failureTrace);
      } catch (e) {
        console.error('[gateway] Failed to persist media upload error turn:', summarizeErrorForLog(e));
      }
      return;
    }

    const onboarding = await this.handleOnboarding(chatId, text);
    if (onboarding) {
      await this.channel!.send(chatId, { text: onboarding });
      return;
    }

    // Emergency check after onboarding completes
    const postOnboardingEmergency = this.handleEmergencyInput(text);
    if (postOnboardingEmergency) {
      try {
        await this.channel!.send(chatId, { text: postOnboardingEmergency });
      } catch (e) {
        console.error('[gateway] Failed to send emergency response:', summarizeErrorForLog(e));
        return;
      }
      try {
        await this.sessions!.recordTurn(chatId, [
          { role: 'user', content: agentInput },
          { role: 'assistant', content: postOnboardingEmergency },
        ]);
      } catch (e) {
        console.error('[gateway] Failed to persist emergency turn:', summarizeErrorForLog(e));
      }
      return;
    }

    let result: Awaited<ReturnType<AgentLoop['run']>>;
    try {
      const history = await this.sessions!.prepareHistory(chatId);
      result = await this.agentLoop!.run(agentInput, history, { chatId });
      await this.channel!.send(chatId, { text: result.text });
    } catch (e) {
      console.error('[gateway] Agent/send error:', summarizeErrorForLog(e));
      try {
        await this.channel!.send(chatId, { text: "I'm having trouble right now. Please try again in a moment." });
      } catch (fallbackError) {
        console.error('[gateway] Failed to send fallback response:', summarizeErrorForLog(fallbackError));
      }
      return;
    }

    try {
      await this.sessions!.recordTurn(
        chatId,
        [
          { role: 'user', content: agentInput },
          ...result.trace,
        ],
      );
      await this.debouncedReconcile(chatId);
    } catch (e) {
      console.error('[gateway] Post-send persistence/reconciliation error:', summarizeErrorForLog(e));
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.reconcileTimers.values()) {
      clearTimeout(timer);
    }
    this.reconcileTimers.clear();
    let firstError: unknown;
    try {
      await this.scheduler?.stop();
    } catch (error) {
      firstError = firstError ?? error;
      console.warn('[gateway] Failed to stop scheduler:', summarizeErrorForLog(error));
    }
    try {
      await this.channel?.disconnect();
    } catch (error) {
      firstError = firstError ?? error;
      console.warn('[gateway] Failed to disconnect channel:', summarizeErrorForLog(error));
    }
    try {
      this.closeStore();
    } catch (error) {
      console.warn('[gateway] Failed to close store:', summarizeErrorForLog(error));
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

    const profileId = (this.config.profiles?.defaultProfileId ?? 'default') as ProfileId;
    const { storePath, auditLogPath } = this.resolveSchedulerPaths(profileId);
    const store = new HeartbeatStore(storePath, profileId);
    this.scheduler = new HeartbeatScheduler(
      store,
      async (job) => this.handleScheduledJob(job, true),
      this.config.heartbeat.timezone,
      {
        auditLogPath,
        defaultMaxRetries: this.config.heartbeat.retry.maxRetries,
        maxGlobalTriggersPerMinute: this.config.heartbeat.rateLimit.maxGlobalTriggersPerMinute,
        maxPerChatTriggersPerMinute: this.config.heartbeat.rateLimit.maxPerChatTriggersPerMinute,
        recoveryEnabled: this.config.heartbeat.recovery.enabled,
        recoveryWindowMinutes: this.config.heartbeat.recovery.windowMinutes,
        retryBackoffMinutes: this.config.heartbeat.retry.backoffMinutes,
      },
    );
    await this.scheduler.start();
    const startupChatId = await this.resolveStartupPolicyChatId();
    if (startupChatId) {
      await this.reconcileHeartbeatPolicies(startupChatId);
    }
    await syncHeartbeatMarkdown(this.getEffectiveWorkspace(), await this.scheduler.listJobs());
  }

  private async handleScheduledJob(job: HeartbeatJob, invokedByScheduler: boolean = false): Promise<void> {
    const profileId = this.getProfileForChat(job.chatId);
    if (profileId === null) {
      console.warn(`[gateway] Skipping heartbeat job ${job.id}: chat is not paired to any profile.`);
      return;
    }
    const decision = decideHeartbeatDelivery(job, {
      now: new Date(Date.now()),
      quietHours: this.config.heartbeat.policy.quietHours,
      lastChatActivityAt: this.sessions!.getLastActiveAt(job.chatId),
      skipIfChatActiveWithinMinutes: this.config.heartbeat.policy.skipIfChatActiveWithinMinutes,
    });
    if (decision.action === 'skip') {
      await this.scheduler?.recordOutcome(job.id, decision.reason);
      return;
    }

    const history = await this.sessions!.prepareHistory(job.chatId);
    const input = [
      '[Heartbeat Trigger]',
      `Job id: ${job.id}`,
      `Job title: ${job.title}`,
      `Prompt: ${job.prompt}`,
    ].join('\n');

    try {
      const result = await this.agentLoop!.run(input, history, { chatId: job.chatId, origin: 'heartbeat' });
      if (result.text === HEARTBEAT_NOOP) {
        await this.sessions!.recordTurn(job.chatId, [
          { role: 'user', content: input },
          ...result.trace,
        ]);
        await this.scheduler?.recordOutcome(job.id, 'noop');
        await this.reconcileHeartbeatPolicies(job.chatId);
        return;
      }

      await this.channel!.send(job.chatId, { text: result.text });
      await this.sessions!.recordTurn(job.chatId, [
        { role: 'user', content: input },
        ...result.trace,
      ]);
      await this.scheduler?.recordOutcome(job.id, 'sent');
      await this.reconcileHeartbeatPolicies(job.chatId);
    } catch (error) {
      if (error instanceof HeartbeatQueueFullError) {
        console.warn(`[gateway] Heartbeat queue full for job ${job.id}; scheduler will retry.`);
        // recordFailure itself touches disk; a storage failure here must not
        // escape (it would double-count the failure via executeJob's catch).
        try {
          await this.scheduler?.recordFailure(job.id, 'heartbeat queue full');
        } catch (recordError) {
          console.warn(
            `[gateway] Failed to record queue-full for job ${job.id}:`,
            summarizeErrorForLog(recordError),
          );
        }
        return;
      }

      if (!invokedByScheduler) {
        // lastError is persisted to disk — sanitize; provider/agent errors can echo PHI.
        try {
          await this.scheduler?.recordFailure(job.id, summarizeErrorForLog(error));
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

  private async reconcileHeartbeatPolicies(chatId: string): Promise<void> {
    if (!this.scheduler) {
      return;
    }

    const desired = await buildDesiredHeartbeatJobs({
      workspacePath: this.getEffectiveWorkspace(),
      chatId,
      timezone: this.config.heartbeat.timezone,
      policy: this.config.heartbeat.policy,
    });
    await reconcilePolicyJobs(this.scheduler, desired);
    await syncHeartbeatMarkdown(this.getEffectiveWorkspace(), await this.scheduler.listJobs());
  }

  private async debouncedReconcile(chatId: string): Promise<void> {
    if (!this.scheduler) {
      return;
    }

    const existing = this.reconcileTimers.get(chatId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(chatId);
      void this.reconcileHeartbeatPolicies(chatId);
    }, 30_000);
    timer.unref();
    this.reconcileTimers.set(chatId, timer);
  }

  private async resolveStartupPolicyChatId(): Promise<string | undefined> {
    const sessionChatId = this.sessions?.getMostRecentChatId();
    if (sessionChatId) {
      this.getProfileForChat(sessionChatId);
      return sessionChatId;
    }

    const jobs = await this.scheduler!.listJobs();
    const persistedChatId = jobs.find((job) => job.chatId !== '__startup__')?.chatId;
    if (persistedChatId) {
      this.getProfileForChat(persistedChatId);
    }
    return persistedChatId;
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
      );
      const result = await flow.handle('restart onboarding');
      await this.sessions?.recordTurn(chatId, [
        { role: 'user', content: input },
        { role: 'assistant', content: result.response },
      ]);
      return result.response;
    }

    const store = new OnboardingStore(workspace);
    const flow = new OnboardingFlow(store, workspace, this.config.heartbeat.timezone);
    if (await flow.isComplete()) {
      return undefined;
    }

    const result = await flow.handle(input);
    if (!result.response) {
      return undefined;
    }
    await this.sessions?.recordTurn(chatId, [
      { role: 'user', content: input },
      { role: 'assistant', content: result.response },
    ]);
    return result.response;
  }

  private handleEmergencyInput(input: string): string | undefined {
    const cleanInput = input
      .split(/\r?\n/)
      .filter((line) => !/^\s*(user id|reply to message id|uploaded media path)\s*:/i.test(line))
      .join('\n');
    if (!EMERGENCY_PATTERN.test(cleanInput)) {
      return undefined;
    }
    return EMERGENCY_RESPONSE;
  }

  private closeStore(): void {
    try {
      this.store?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close memory store:', summarizeErrorForLog(error));
    } finally {
      this.store = undefined;
    }
  }

  // Copies workspace template files from the project's workspace/ dir to the workspace/
  // Only copies if the file does not already exist (preserves user edits).
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

  // Constructs the ProfileRegistry. Never throws — a construction failure
  // (e.g. an unwritable baseDir) degrades to "no profile registry", which
  // callers treat as "use the legacy single-user paths" everywhere below.
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

  // Idempotently migrates the legacy single-user workspace into the
  // profile-scoped layout (via ProfileRegistry.migrateLegacyWorkspace, which
  // already handles the sentinel + idempotent per-file copy) and decides
  // which workspace path the rest of startup should use.
  //
  // Decision rule: only switch to the profile-scoped workspace once the
  // migration sentinel is actually present (i.e. migration is confirmed
  // complete with zero errors). A failed or partial migration must never
  // brick the daemon, so on any error — or on an unexpected exception — this
  // falls back to the legacy workspace path untouched.
  private migrateAndResolveWorkspace(
    registry: ProfileRegistry,
    profileId: ProfileId,
    legacyWorkspace: string,
  ): string {
    try {
      if (registry.hasBeenMigrated(profileId, legacyWorkspace)) {
        const profileWorkspace = registry.profileWorkspace(profileId);
        console.log(`[gateway] Profile "${profileId}" already migrated; using ${profileWorkspace}`);
        return profileWorkspace;
      }

      const result = registry.migrateLegacyWorkspace(legacyWorkspace);
      console.log(
        `[gateway] Legacy workspace migration: migrated=${result.migrated} skipped=${result.skipped} errors=${result.errors.length}`,
      );
      if (result.errors.length > 0) {
        // Error strings carry workspace-relative health-file paths (PHI
        // context) — log the count only, never the list.
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
    try {
      const healthResults = await checkSystemReadiness(this.config, { allowNetworkChecks: true });
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
    } catch (error) {
      console.warn('[gateway] Boot healthcheck failed:', summarizeErrorForLog(error));
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
    const lines = [
      'System Health:',
      ...h.providers.map((p) => `  ${p.label}: ${p.ready ? 'OK' : 'FAIL'}`),
      `  telegram: ${h.telegram.ready ? 'OK' : 'FAIL'}`,
    ];
    // Security warnings carry config internals (provider baseUrls, workspace
    // filesystem paths) and must never reach a network channel — surface the
    // count only; full text stays on the local console/CLI.
    if (this.securityWarnings.length > 0) {
      lines.push('', `Security warnings: ${this.securityWarnings.length} (details in local logs)`);
    }
    lines.push('', 'See `npm run cli -- status` for details.');
    return lines.join('\n');
  }

  private getEffectiveWorkspace(): string {
    return this.resolvedMemoryWorkspace ?? this.config.memory.workspace;
  }

  // P0 persists pairings only; runtime dispatch is single-profile at boot.
  // Auto-pair is a first-contact bridge (PD-16 pairing codes land in P6): it
  // fires ONLY while no chat is paired to any profile. Once the owner's first
  // chat is paired, every other unknown chatId is refused (returns null) —
  // otherwise a leaked bot token would let a stranger pair themselves to the
  // default profile and read the owner's health memory through the chat tools.
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

  // Same sentinel-gated fallback as migrateAndResolveWorkspace: heartbeat
  // store + scheduler audit log only move to profile-scoped paths once the
  // workspace migration sentinel confirms migration completed cleanly.
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

