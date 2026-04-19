import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from '../config/types';
import type { Channel, IncomingMessage } from '../channels/types';
import { TelegramChannel } from '../channels/telegram';
import { AgentLoop } from '../agent/agent-loop';
import { ContextAssembler } from '../agent/context';
import { MemoryEngine } from '../memory/memory-engine';
import { ToolRegistry } from '../tools/registry';
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

export class Gateway {
  private config: AppConfig;
  private channel?: Channel;
  private agentLoop?: AgentLoop;
  private sessions?: SessionManager;
  private scheduler?: HeartbeatScheduler;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const { config } = this;

    console.log('[gateway] Starting Redacted...');

    // Bootstrap workspace with template files on first run
    this.bootstrapWorkspace(config.memory.workspace);

    // Memory
    const memory = new MemoryEngine(config.memory.workspace);
    const dbPath = path.join(config.memory.workspace, '..', 'search.db');
    const store = new SqliteStore(dbPath);
    const embeddingProvider = createProvider(config.providers.embeddings);
    const { MemoryIndexer } = await import('../memory/indexer');
    const indexer = new MemoryIndexer(store, embeddingProvider, config.memory.workspace);
    await indexer.indexAll();
    console.log('[gateway] Memory index ready');

    const search = new MemorySearch(store, embeddingProvider, config.memory.search.hybridWeights);

    // Providers
    const mainProvider = createProvider(config.providers.main);

    // Tools
    const registry = new ToolRegistry(config.tools);
    for (const tool of createMemoryTools(memory, search)) {
      registry.register(tool);
    }

    // Medical tools with medical provider
    const medicalProvider = createProvider(config.providers.medical);
    for (const tool of createMedicalTools(memory, search, medicalProvider, mainProvider, config.memory.workspace)) {
      registry.register(tool);
    }

    // Context
    const assembler = new ContextAssembler(memory, config.memory.bootstrapMaxChars);
    const systemMessages = await assembler.buildSystemMessages();

    // Agent
    this.agentLoop = new AgentLoop(mainProvider, registry, systemMessages, config.agent);

    // Sessions
    this.sessions = new SessionManager(
      config.sessions.softResetAfterMinutes,
      config.sessions.hardResetAfterMinutes,
      undefined,
      mainProvider,
      registry,
      config.sessions.compaction,
    );

    // Channel
    if (config.channels.telegram.enabled) {
      const token = config.channels.telegram.botToken || process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        console.error('[gateway] TELEGRAM_BOT_TOKEN not set. Set it in config or environment.');
        process.exit(1);
      }
      this.channel = new TelegramChannel(token, config.memory.workspace);
      this.channel.onMessage((msg) => this.handleMessage(msg));
      await this.channel.connect();
    }

    await this.initializeScheduler();
    if (this.scheduler) {
      registry.register(createCronManageTool(this.scheduler, config.memory.workspace));
      registry.register(createHeartbeatManageTool(this.scheduler, config.memory.workspace));
    }

    console.log('[gateway] Redacted is running.');
  }

  async handleTestMessage(chatId: string, text: string): Promise<string> {
    const history = await this.sessions!.prepareHistory(chatId);
    const result = await this.agentLoop!.run(text, history, { chatId });
    await this.sessions!.recordTurn(chatId, [
      { role: 'user', content: text },
      ...result.trace,
    ]);
    await this.reconcileHeartbeatPolicies(chatId);
    return result.text;
  }

  private async handleMessage(incoming: IncomingMessage): Promise<void> {
    const { chatId, text } = incoming;
    console.log(`[gateway] Message from ${chatId}: ${text.slice(0, 80)}`);

    const agentInput = this.buildAgentInput(incoming);

    // Handle /new command
    if (text.trim() === '/new') {
      await this.sessions!.resetSession(chatId);
      await this.channel!.send(chatId, { text: 'Starting fresh session. Your health memory is preserved.' });
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
        console.error('[gateway] Failed to send media upload error:', e);
        return;
      }

      try {
        await this.sessions!.recordTurn(chatId, failureTrace);
      } catch (e) {
        console.error('[gateway] Failed to persist media upload error turn:', e);
      }
      return;
    }

    const history = await this.sessions!.prepareHistory(chatId);

    try {
      const result = await this.agentLoop!.run(agentInput, history, { chatId });
      await this.channel!.send(chatId, { text: result.text });

      await this.sessions!.recordTurn(
        chatId,
        [
          { role: 'user', content: agentInput },
          ...result.trace,
        ],
      );
      await this.reconcileHeartbeatPolicies(chatId);
    } catch (e) {
      console.error('[gateway] Agent error:', e);
      await this.channel!.send(chatId, { text: "I'm having trouble right now. Please try again in a moment." });
    }
  }

  async stop(): Promise<void> {
    await this.scheduler?.stop();
    await this.channel?.disconnect();
    console.log('[gateway] Stopped.');
  }

  private async initializeScheduler(): Promise<void> {
    if (!this.config.heartbeat.enabled) {
      return;
    }
    if (!this.channel || !this.agentLoop || !this.sessions) {
      return;
    }

    const store = new HeartbeatStore(this.config.heartbeat.storePath);
    this.scheduler = new HeartbeatScheduler(
      store,
      async (job) => this.handleScheduledJob(job, true),
      this.config.heartbeat.timezone,
      {
        auditLogPath: this.config.heartbeat.audit.path,
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
    await syncHeartbeatMarkdown(this.config.memory.workspace, await this.scheduler.listJobs());
  }

  private async handleScheduledJob(job: HeartbeatJob, invokedByScheduler: boolean = false): Promise<void> {
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
      const result = await this.agentLoop!.run(input, history, { chatId: job.chatId });
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
      if (!invokedByScheduler) {
        const message = error instanceof Error ? error.message : String(error);
        await this.scheduler?.recordFailure(job.id, message);
      }
      throw error;
    }
  }

  private async reconcileHeartbeatPolicies(chatId: string): Promise<void> {
    if (!this.scheduler) {
      return;
    }

    const desired = await buildDesiredHeartbeatJobs({
      workspacePath: this.config.memory.workspace,
      chatId,
      timezone: this.config.heartbeat.timezone,
      policy: this.config.heartbeat.policy,
    });
    await reconcilePolicyJobs(this.scheduler, desired);
    await syncHeartbeatMarkdown(this.config.memory.workspace, await this.scheduler.listJobs());
  }

  private async resolveStartupPolicyChatId(): Promise<string | undefined> {
    const sessionChatId = this.sessions?.getMostRecentChatId();
    if (sessionChatId) {
      return sessionChatId;
    }

    const jobs = await this.scheduler!.listJobs();
    const persistedChatId = jobs.find((job) => job.chatId !== '__startup__')?.chatId;
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

  // Copies workspace template files from the project's workspace/ dir to the workspace/
  // Only copies if the file does not already exist (preserves user edits).
  private bootstrapWorkspace(workspacePath: string): void {
    fs.mkdirSync(workspacePath, { recursive: true });
    // In compiled JS, __dirname is dist/gateway so ../../workspace goes to project root workspace/
    // In source, we need to resolve from the source location
    const templateDir = path.join(__dirname, '..', '..', 'workspace');
    if (!fs.existsSync(templateDir)) return;
    for (const file of fs.readdirSync(templateDir)) {
      const dest = path.join(workspacePath, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(templateDir, file), dest);
        console.log(`[gateway] Bootstrapped ${file} to workspace`);
      }
    }
  }
}
