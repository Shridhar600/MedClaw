import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as cron from 'node-cron';
import type { AppConfig } from '../config/types';
import type { ProfileId } from '../profiles';
import { WriteQueue, replayJournal } from '../profiles';
import {
  LedgerStore,
  NarrativeStore,
  SafetyView,
  EpisodeStore,
  CuriosityQueue,
  CuratedMemory,
  TYPE_TO_FILE,
  normalizeEntity,
} from '../memcore';
import type {
  CuriosityItem,
  FactType,
  LedgerIndexDelta,
  NarrativeIndexDelta,
} from '../memcore';
import {
  SqliteFactMirror,
  SqliteEventSink,
  SqliteVecIndex,
  SqliteKeywordIndex,
  SqliteChunkStats,
  SqliteSessionIndex,
  ledgerFactToRecord,
  isRemoteEmbeddingBaseUrl,
} from '../indexstore';
import type { EmbeddingPort } from '../ports';
import { systemClock } from '../ports';
import { CapturePipeline, FileCaptureIdempotency, makeSafetyRenderer } from '../capture';
import { SqliteStore } from '../memory/sqlite-store';
import { MemorySearch } from '../memory/search';
import { MemoryEngine } from '../memory/memory-engine';
import type { MemoryIndexer as MemoryIndexerType, MemoryIndexDelta } from '../memory/indexer';
import { createMemoryTools } from '../tools/memory-tools';
import { createMedicalTools } from '../tools/medical-tools';
import type { MedicalContextProvider } from '../tools/medical-tools';
import { createCronManageTool } from '../tools/cron-manage';
import { createHeartbeatManageTool } from '../tools/heartbeat-manage';
import { createLedgerTools } from '../tools/ledger-tools';
import { createEpisodeTools } from '../tools/episode-tools';
import { createSafetyTools } from '../tools/safety-tools';
import { createSessionTools } from '../tools/session-tools';
import { ToolRegistry } from '../tools/registry';
import { AgentLoop } from '../agent/agent-loop';
import type { PrepareSystem } from '../agent/agent-loop';
import { ContextAssembler } from '../agent/context';
import { ContextAssembler as ContextAssemblerV2 } from '../context2';
import { RecallEngine, DEFAULT_RECALL_CONFIG } from '../recall';
import { createProvider } from '../providers/factory';
import type { LLMProvider } from '../providers/types';
import type { LLMSemaphore } from '../tools/semaphore';
import { SessionManager } from './session';
import { HeartbeatStore } from '../scheduler/store';
import { HeartbeatScheduler } from '../scheduler/runtime';
import { runNightlySweep } from '../scheduler/transcript-sweep-job';
import type { LedgerDayRead, NightlySweepDeps, NightlySweepResult } from '../scheduler/transcript-sweep-job';
import type { HeartbeatJob } from '../scheduler/types';
import {
  secureMkdir,
  secureWriteViaTmp,
  summarizeErrorForLog,
} from '../security';

const INDEX_EMBED_TIMEOUT_MS = 500;
const INDEX_EMBED_COOLDOWN_MS = 1_000;
const HEARTBEAT_CURIOSITY_LIMIT = 5;

type SignalEmbeddingProvider = LLMProvider & {
  embedWithSignal?: (text: string, signal: AbortSignal) => Promise<number[]>;
};

function makeBoundedEmbeddingProvider(provider: LLMProvider): LLMProvider {
  let unavailableUntil = 0;
  const signalProvider = provider as SignalEmbeddingProvider;
  return {
    modelName: provider.modelName,
    chat: (messages, tools) => provider.chat(messages, tools),
    embed: async (text: string): Promise<number[]> => {
      if (Date.now() < unavailableUntil) {
        throw new Error('embedding provider temporarily unavailable');
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = typeof signalProvider.embedWithSignal === 'function'
        ? signalProvider.embedWithSignal(text, controller.signal)
        : provider.embed(text);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          unavailableUntil = Date.now() + INDEX_EMBED_COOLDOWN_MS;
          controller.abort();
          reject(new Error('embedding timeout'));
        }, INDEX_EMBED_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        return await Promise.race([work, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

function dueCuriosityItems(items: CuriosityItem[], now: Date): CuriosityItem[] {
  const clinicalKinds = new Set(['follow-up', 'medication-reminder', 'lab-correlation', 'missing-data']);
  return items
    .filter(item => {
      if (!item.dueAt) return true;
      const dueAt = Date.parse(item.dueAt);
      return Number.isNaN(dueAt) || dueAt <= now.getTime();
    })
    .sort((a, b) => {
      const priority = (item: CuriosityItem): number => item.critical || clinicalKinds.has(item.kind) ? 0 : 1;
      const dueRank = (item: CuriosityItem): number => {
        const value = item.dueAt ? Date.parse(item.dueAt) : Date.parse(item.createdAt);
        return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
      };
      return priority(a) - priority(b)
        || dueRank(a) - dueRank(b)
        || a.createdAt.localeCompare(b.createdAt)
        || a.id.localeCompare(b.id);
    })
    .slice(0, HEARTBEAT_CURIOSITY_LIMIT);
}

export interface ProfileRuntimeDeps {
  profileId: ProfileId;
  workspace: string;
  dbPath: string;
  sessionsPath?: string;
  schedulerPaths: { storePath: string; auditLogPath: string };
  config: AppConfig;
  mainProvider: LLMProvider;
  semaphore: LLMSemaphore;
  canSchedule?: boolean;
  runScheduledJob?: (job: HeartbeatJob) => Promise<void>;
  sideEffectLookup?: (entity: string) => Promise<string[]>;
}

export class ProfileRuntime {
  readonly profileId: ProfileId;
  readonly workspace: string;
  config: AppConfig;

  store?: SqliteStore;
  factMirror?: SqliteFactMirror;
  eventSink?: SqliteEventSink;
  sessionIndex?: SqliteSessionIndex;
  curiosity?: CuriosityQueue;
  ledgerStore?: LedgerStore;
  narrativeStore?: NarrativeStore;
  safetyView?: SafetyView;
  episodeStore?: EpisodeStore;
  curatedMemory?: CuratedMemory;
  writeQueue?: WriteQueue;
  capturePipeline?: CapturePipeline;
  indexer?: MemoryIndexerType;
  registry?: ToolRegistry;
  agentLoop?: AgentLoop;
  sessions?: SessionManager;
  scheduler?: HeartbeatScheduler;
  vectorIndex?: SqliteVecIndex;
  keywordIndex?: SqliteKeywordIndex;
  chunkStats?: SqliteChunkStats;
  recallEngine?: RecallEngine;
  v2Assembler?: ContextAssemblerV2;

  sweepTask?: cron.ScheduledTask;
  sweepInFlight?: Promise<NightlySweepResult>;
  sweepStopping = false;
  stopping = false;
  closed = false;

  promptMode: 'per-turn' | 'boot-cached' = 'boot-cached';
  sessionSummarySink?: (chatId: string, anchoredSummary: string) => Promise<void>;

  readonly reindexTails: Map<string, Promise<void>> = new Map();
  readonly pendingIndexDeltas: Map<string, MemoryIndexDelta[]> = new Map();
  readonly backgroundOperations: Set<Promise<void>> = new Set();
  readonly inFlightOperations: Set<Promise<unknown>> = new Set();
  readonly dirtyIndexPaths: Set<string> = new Set();
  dirtyIndexMarkerPath?: string;

  constructor(profileId: ProfileId = 'default' as ProfileId, workspace = '', config?: AppConfig) {
    this.profileId = profileId;
    this.workspace = workspace;
    this.config = config ?? ({} as AppConfig);
  }

  isStopping(): boolean {
    return this.stopping;
  }

  isClosed(): boolean {
    return this.closed;
  }

  static async create(deps: ProfileRuntimeDeps): Promise<ProfileRuntime> {
    const {
      profileId,
      workspace: memoryWorkspace,
      dbPath,
      sessionsPath,
      schedulerPaths,
      config,
      mainProvider,
      semaphore,
      sideEffectLookup,
    } = deps;

    const runtime = new ProfileRuntime(profileId, memoryWorkspace, config);
    runtime.stopping = false;
    runtime.closed = false;
    runtime.pendingIndexDeltas.clear();

    secureMkdir(path.dirname(dbPath));

    const memory = new MemoryEngine(memoryWorkspace, profileId);
    const store = new SqliteStore(dbPath, profileId);
    runtime.store = store;

    const embeddingProvider = createProvider(config.providers.embeddings);
    const boundedEmbeddingProvider = makeBoundedEmbeddingProvider(embeddingProvider);
    const { MemoryIndexer } = await import('../memory/indexer');
    const indexer = new MemoryIndexer(
      store,
      boundedEmbeddingProvider,
      memoryWorkspace,
      profileId,
      (relativePath) => runtime.takePendingIndexDelta(relativePath),
    );
    runtime.indexer = indexer;
    runtime.dirtyIndexMarkerPath = path.join(memoryWorkspace, '.state', 'index-dirty.json');

    try {
      await indexer.indexAll();
      runtime.clearAllDirtyIndexMarkers();
      console.log('[gateway] Memory index ready');
    } catch (error) {
      console.warn('[gateway] Memory index unavailable; continuing with degraded search:', summarizeErrorForLog(error));
    }

    if (isRemoteEmbeddingBaseUrl(config.providers.embeddings.baseUrl)) {
      console.warn('[gateway] Embeddings provider is remote — the recall latency budget (p50<=300ms / p95<=800ms) assumes local embeddings; expect higher per-turn recall latency.');
    }

    const search = new MemorySearch(store, boundedEmbeddingProvider, config.memory.search.hybridWeights, profileId);

    let medicalContextProvider: MedicalContextProvider | undefined;

    const registry = new ToolRegistry(config.tools);
    runtime.registry = registry;

    try {
      for (const tool of createMemoryTools(memory, search, indexer, profileId, () => runtime.factMirror)) {
        registry.register(tool);
      }
    } catch (e) {
      console.warn('[gateway] Memory tools unavailable; continuing without them:', summarizeErrorForLog(e));
    }

    try {
      const medicalProvider = createProvider(config.providers.medical);
      for (const tool of createMedicalTools(
        memory,
        (query) => medicalContextProvider ? medicalContextProvider(query) : Promise.resolve(''),
        medicalProvider,
        mainProvider,
        memoryWorkspace,
        {
          medicalProviderType: config.providers.medical.type,
          medicalProviderBaseUrl: config.providers.medical.baseUrl,
          allowRawMedicalMedia: config.providers.medical.allowRawMedicalMedia,
          mainProviderType: config.providers.main.type,
          mainProviderBaseUrl: config.providers.main.baseUrl,
        },
      )) {
        registry.register(tool);
      }
    } catch (e) {
      console.warn('[gateway] Medical tools unavailable; continuing without them:', summarizeErrorForLog(e));
    }

    let prepareSystem: PrepareSystem | undefined;

    try {
      const stateDir = path.join(memoryWorkspace, '.state');
      secureMkdir(stateDir);
      const journalPath = path.join(stateDir, 'write-queue.journal');
      const writeQueue = new WriteQueue({
        journalPath,
        onReconcile: (record): void => {
          console.warn('[gateway] unresolved write-queue intent detected:', record.label);
        },
      });
      runtime.writeQueue = writeQueue;

      try {
        await replayJournal(journalPath, (label) => {
          console.warn('[gateway] unresolved write-queue intent at boot:', label);
        });
      } catch (e) {
        console.warn('[gateway] write-queue journal reconciliation failed:', summarizeErrorForLog(e));
      }

      const ledgerStore = new LedgerStore(memoryWorkspace);
      runtime.ledgerStore = ledgerStore;
      const narrativeStore = new NarrativeStore(memoryWorkspace);
      runtime.narrativeStore = narrativeStore;
      const safetyView = new SafetyView(
        memoryWorkspace,
        systemClock,
        () => ledgerStore.listSafetyRelevant(),
      );
      runtime.safetyView = safetyView;
      const episodeStore = new EpisodeStore(memoryWorkspace);
      runtime.episodeStore = episodeStore;
      const curiosityQueue = new CuriosityQueue(memoryWorkspace, undefined, undefined, profileId);
      runtime.curiosity = curiosityQueue;
      const curatedMemory = new CuratedMemory(memoryWorkspace, {
        budgetChars: config.memory.bootstrapMaxChars,
        budgetRatios: config.memory.budgetRatios,
      });
      runtime.curatedMemory = curatedMemory;
      const safetyRenderer = makeSafetyRenderer({
        render: (facts) => safetyView.render(facts),
        listSafetyRelevant: () => ledgerStore.listSafetyRelevant(),
        markDirty: () => safetyView.markDirty(),
      });

      runtime.sessionSummarySink = async (chatId: string, anchoredSummary: string): Promise<void> => {
        const day = new Date().toISOString().slice(0, 10);
        await writeQueue.enqueue('background', {
          label: 'session-summary',
          run: () => narrativeStore.appendSessionSummary(chatId, day, anchoredSummary),
        });
      };

      const factMirror = new SqliteFactMirror({ dbPath });
      runtime.factMirror = factMirror;
      const eventSink = new SqliteEventSink({ dbPath });
      runtime.eventSink = eventSink;

      const fileToType = new Map<string, FactType>(
        (Object.entries(TYPE_TO_FILE) as [FactType, string][]).map(([t, f]) => [f, t]),
      );
      const mirrorTails: Map<FactType, Promise<void>> = new Map();
      const rederive = {
        rederive: async (relPaths: string[]): Promise<void> => {
          if (runtime.stopping || runtime.closed) return;
          for (const rel of new Set(relPaths)) {
            if (runtime.stopping || runtime.closed) return;
            const type = rel.startsWith('ledger/')
              ? fileToType.get(rel.slice('ledger/'.length))
              : undefined;
            const sourceDelta = type
              ? ledgerStore.takeIndexDelta(type)
              : runtime.narrativeDeltaFor(rel, narrativeStore);
            if (sourceDelta) {
              runtime.enqueuePendingIndexDelta(rel, sourceDelta);
            }
            await runtime.markIndexDirty(memoryWorkspace, rel, store, sourceDelta?.hash);
            if (type) {
              const previous = mirrorTails.get(type) ?? Promise.resolve();
              const refresh = previous
                .catch(() => undefined)
                .then(async () => {
                  if (runtime.stopping || runtime.closed) return;
                  try {
                    const entities = sourceDelta && type && 'entities' in sourceDelta
                      ? [...new Set((sourceDelta as LedgerIndexDelta).entities)]
                      : [];
                    if (entities.length > 0) {
                      for (const entity of entities) {
                        const facts = await ledgerStore.listAllOfEntity(type, entity);
                        await factMirror.replaceScope(type, entity, facts.map(ledgerFactToRecord));
                      }
                    } else {
                      const facts = await ledgerStore.listAllOfType(type);
                      await factMirror.replaceType(type, facts.map(ledgerFactToRecord));
                    }
                  } catch (e) {
                    console.warn('[gateway] fact-mirror re-derive failed (rebuildable at boot):', summarizeErrorForLog(e));
                  }
                });
              mirrorTails.set(type, refresh);
              await refresh;
              if (mirrorTails.get(type) === refresh) mirrorTails.delete(type);
              if (runtime.stopping || runtime.closed) return;
            }
            runtime.queueBackgroundReindex(rel, async () => {
              try {
                await indexer.indexFile(rel);
                runtime.clearIndexDirty(rel);
              } catch (e) {
                console.warn('[gateway] incremental reindex failed for a changed file:', summarizeErrorForLog(e));
              }
            });
          }
        },
      };

      try {
        let records = [] as ReturnType<typeof ledgerFactToRecord>[];
        for (const t of Object.keys(TYPE_TO_FILE) as FactType[]) {
          records = records.concat((await ledgerStore.listAllOfType(t)).map(ledgerFactToRecord));
        }
        await factMirror.rebuild(records);
        console.log(`[gateway] Fact mirror rebuilt from ledger (${records.length} facts)`);
      } catch (e) {
        console.warn('[gateway] Fact-mirror boot rebuild failed (recall Stage 1 may degrade):', summarizeErrorForLog(e));
      }

      const pipeline = new CapturePipeline({
        queue: writeQueue,
        ledger: ledgerStore,
        narrative: narrativeStore,
        safety: safetyRenderer,
        curiosity: curiosityQueue,
        events: eventSink,
        rederive,
        idempotency: new FileCaptureIdempotency(path.join(stateDir, 'capture-idempotency.log')),
      });
      runtime.capturePipeline = pipeline;

      try {
        await safetyRenderer.render(await ledgerStore.listSafetyRelevant());
      } catch (e) {
        console.warn('[gateway] boot SAFETY reconciliation failed (continuing):', summarizeErrorForLog(e));
      }

      try {
        let cachedDim: number | null = null;
        const embeddingPort: EmbeddingPort = {
          embed: (texts) => Promise.all(texts.map((t) => boundedEmbeddingProvider.embed(t))),
          dim: async () => {
            if (cachedDim === null) cachedDim = (await boundedEmbeddingProvider.embed('')).length;
            return cachedDim;
          },
          modelId: async () => config.providers.embeddings.model,
        };
        const vectorIndex = new SqliteVecIndex({ dbPath });
        runtime.vectorIndex = vectorIndex;
        const keywordIndex = new SqliteKeywordIndex({ dbPath });
        runtime.keywordIndex = keywordIndex;
        const chunkStats = new SqliteChunkStats({ dbPath });
        runtime.chunkStats = chunkStats;
        const recallEngine = new RecallEngine({
          embedding: embeddingPort,
          vectorIndex,
          keywordIndex,
          factMirror,
          chunkStats,
          clock: systemClock,
          config: DEFAULT_RECALL_CONFIG,
        });
        runtime.recallEngine = recallEngine;
        const v2Assembler = new ContextAssemblerV2({
          reader: memory,
          safety: safetyView,
          maxChars: config.memory.bootstrapMaxChars,
          clock: systemClock,
          curatedMemory: {
            readForContext: (maxChars, budgetRatios): ReturnType<CuratedMemory['readForContext']> =>
              curatedMemory.readForContext(maxChars, budgetRatios),
          },
          budgetRatios: config.memory.budgetRatios,
        });
        runtime.v2Assembler = v2Assembler;

        medicalContextProvider = async (userMessage): ReturnType<MedicalContextProvider> => {
          let recall = null as Awaited<ReturnType<typeof recallEngine.run>> | null;
          let status: 'available' | 'unreadable' | 'provider-unavailable' = 'available';
          try {
            recall = await recallEngine.run({ profileId, userMessage }, { narrative: true });
          } catch (e) {
            status = 'provider-unavailable';
            console.warn('[gateway] medical recall failed (using SAFETY/profile only):', summarizeErrorForLog(e));
          }
          const report = await v2Assembler.assemble(profileId, 'chat', recall);
          const medicalKeys = new Set(['SAFETY.md', 'active-ledger', 'recall', 'check']);
          const content = report.sections
            .filter((section) => medicalKeys.has(section.key))
            .map((section) => `## ${section.title}\n${section.content}`)
            .join('\n\n');
          if (status === 'available' && report.degraded.length > 0) status = 'unreadable';
          if (status === 'available' && recall?.indexStatus === 'failed') status = 'provider-unavailable';
          return { content, status };
        };

        prepareSystem = async (mode, userMessage): ReturnType<PrepareSystem> => {
          let recall = null as Awaited<ReturnType<typeof recallEngine.run>> | null;
          try {
            recall = await recallEngine.run({ profileId, userMessage }, { narrative: mode === 'chat' });
          } catch (e) {
            console.warn('[gateway] recall failed (assembling without recall):', summarizeErrorForLog(e));
            recall = null;
          }
          if (mode === 'heartbeat') {
            try {
              const items = dueCuriosityItems(await curiosityQueue.list(), systemClock.now());
              recall = recall
                ? { ...recall, curiosity: items }
                : {
                  ledger: '', ledgerTokens: 0, ledgerTruncated: false,
                  narrative: '', narrativeTokens: 0, hits: [], injectedChunkIds: [],
                  indexStatus: 'failed' as const, checkNotes: '', curiosity: items,
                };
            } catch (e) {
              console.warn('[gateway] heartbeat curiosity read unavailable:', summarizeErrorForLog(e));
              recall = recall
                ? { ...recall, curiosityStatus: 'unreadable' }
                : {
                  ledger: '', ledgerTokens: 0, ledgerTruncated: false,
                  narrative: '', narrativeTokens: 0, hits: [], injectedChunkIds: [],
                  indexStatus: 'failed' as const, checkNotes: '', curiosityStatus: 'unreadable' as const,
                };
            }
          }
          const report = await v2Assembler.assemble(profileId, mode, recall);
          return {
            messages: [{ role: 'system', content: report.content }],
            recordUsed: recall
              ? (ids): Promise<void> => recallEngine.recordUsage(ids, systemClock.now().toISOString(), recall!.injectedChunkIds)
              : undefined,
            healthContextTouched: report.sections.some((section) =>
              ['SAFETY.md', 'HEALTH_PROFILE.md', 'active-ledger', 'recall', 'check', 'curiosity'].includes(section.key)),
          };
        };
        console.log('[gateway] Per-turn recall + v2 context assembler ready (D9)');
      } catch (e) {
        console.warn('[gateway] Recall/v2-assembler unavailable; chat uses the boot-cached prompt:', summarizeErrorForLog(e));
      }

      try {
        const sideEffects = sideEffectLookup ?? ((): Promise<string[]> => Promise.resolve([]));
        for (const tool of createLedgerTools({
          pipeline,
          ledger: ledgerStore,
          safety: safetyRenderer,
          queue: writeQueue,
          narrative: narrativeStore,
          sideEffectLookup: sideEffects,
          afterLedgerMutation: (type): Promise<void> => rederive.rederive([`ledger/${TYPE_TO_FILE[type]}`]),
        })) {
          registry.register(tool);
        }
      } catch (e) {
        console.warn('[gateway] Ledger tools unavailable; continuing without them:', summarizeErrorForLog(e));
      }

      try {
        for (const tool of createEpisodeTools({ store: episodeStore, profileId })) {
          registry.register(tool);
        }
      } catch (e) {
        console.warn('[gateway] Episode tools unavailable; continuing without them:', summarizeErrorForLog(e));
      }

      try {
        for (const tool of createSafetyTools({ safetyView })) {
          registry.register(tool);
        }
      } catch (e) {
        console.warn('[gateway] Safety tools unavailable; continuing without them:', summarizeErrorForLog(e));
      }
    } catch (e) {
      console.warn('[gateway] Memory-core (v2) unavailable; continuing without ledger/episode/safety tools + per-turn capture:', summarizeErrorForLog(e));
    }

    const assembler = new ContextAssembler(memory, config.memory.bootstrapMaxChars, profileId);
    const systemMessages = await assembler.buildSystemMessages();

    const agentSystem: PrepareSystem = prepareSystem ?? (async (): ReturnType<PrepareSystem> => ({
      messages: systemMessages,
      healthContextTouched: systemMessages.length > 0,
    }));
    const agentLoop = new AgentLoop(mainProvider, registry, agentSystem, config.agent, semaphore);
    runtime.agentLoop = agentLoop;
    runtime.promptMode = prepareSystem ? 'per-turn' : 'boot-cached';

    const sessions = new SessionManager({
      sessionsPath,
      softResetMinutes: config.sessions.softResetAfterMinutes,
      hardResetMinutes: config.sessions.hardResetAfterMinutes,
      provider: mainProvider,
      toolRegistry: registry,
      compaction: config.sessions.compaction,
      window: config.sessions.window,
      contextWindow: config.providers.main.contextWindow,
      profileId,
      perChatArchive: true,
    });
    runtime.sessions = sessions;

    sessions.setBackgroundRunner((fn) => semaphore.run('background', fn));
    if (runtime.sessionSummarySink) {
      sessions.setSummarySink(runtime.sessionSummarySink);
      try {
        await sessions.retryPendingSummaries();
      } catch (e) {
        console.warn('[gateway] Pending session-summary retry failed; continuing:', summarizeErrorForLog(e));
      }
    }

    try {
      const sessionIndex = new SqliteSessionIndex({ dbPath, sessionsDir: sessions.sessionsDir });
      runtime.sessionIndex = sessionIndex;
      sessions.setTurnIndex(sessionIndex);
      for (const tool of createSessionTools({ index: sessionIndex })) {
        registry.register(tool);
      }
    } catch (e) {
      console.warn('[gateway] session_search unavailable; continuing without it:', summarizeErrorForLog(e));
    }

    if (deps.canSchedule && deps.runScheduledJob && config.heartbeat.enabled) {
      await runtime.initializeScheduler({
        schedulerPaths,
        runScheduledJob: deps.runScheduledJob,
      });
    }

    runtime.sweepStopping = false;
    try {
      runtime.sweepTask?.stop();
      runtime.sweepTask = cron.schedule(
        '15 3 * * *',
        () => { runtime.launchBackgroundSweep(); },
        { scheduled: true, timezone: config.heartbeat.timezone },
      );
    } catch (e) {
      console.warn('[gateway] nightly transcript sweep could not be scheduled; continuing:', summarizeErrorForLog(e));
    }

    return runtime;
  }

  async initializeScheduler(options: {
    schedulerPaths: { storePath: string; auditLogPath: string };
    runScheduledJob: (job: HeartbeatJob) => Promise<void>;
  }): Promise<void> {
    if (!this.config.heartbeat?.enabled) {
      return;
    }
    if (this.stopping || this.closed) {
      return;
    }
    const { schedulerPaths, runScheduledJob } = options;
    const store = new HeartbeatStore(schedulerPaths.storePath, this.profileId);
    this.scheduler = new HeartbeatScheduler(
      store,
      runScheduledJob,
      this.config.heartbeat.timezone,
      {
        auditLogPath: schedulerPaths.auditLogPath,
        defaultMaxRetries: this.config.heartbeat.retry.maxRetries,
        maxGlobalTriggersPerMinute: this.config.heartbeat.rateLimit.maxGlobalTriggersPerMinute,
        maxPerChatTriggersPerMinute: this.config.heartbeat.rateLimit.maxPerChatTriggersPerMinute,
        recoveryEnabled: this.config.heartbeat.recovery.enabled,
        recoveryWindowMinutes: this.config.heartbeat.recovery.windowMinutes,
        retryBackoffMinutes: this.config.heartbeat.retry.backoffMinutes,
      },
    );
    await this.scheduler.start();

    if (this.registry) {
      try {
        this.registry.register(createCronManageTool(this.scheduler, this.workspace));
        this.registry.register(createHeartbeatManageTool(this.scheduler, this.workspace));
      } catch (e) {
        console.warn('[gateway] Cron/heartbeat tools unavailable; continuing without them:', summarizeErrorForLog(e));
      }
    }
  }

  beginStopping(): void {
    this.stopping = true;
    this.sweepStopping = true;
  }

  async drainAndClose(): Promise<void> {
    if (this.closed) return;
    this.beginStopping();
    let firstError: unknown;

    try {
      this.sweepTask?.stop();
      this.sweepTask = undefined;
    } catch (error) {
      console.warn('[gateway] Failed to stop transcript sweep:', summarizeErrorForLog(error));
    }

    try {
      await this.scheduler?.stop();
    } catch (error) {
      firstError = firstError ?? error;
      console.warn('[gateway] Failed to stop scheduler:', summarizeErrorForLog(error));
    }

    try {
      await this.drainInFlightOperations();
    } catch (error) {
      console.warn('[gateway] Failed to drain Gateway operations:', summarizeErrorForLog(error));
    }

    try {
      await this.sweepInFlight?.catch(() => undefined);
    } catch (error) {
      console.warn('[gateway] Failed to drain transcript sweep:', summarizeErrorForLog(error));
    }

    try {
      await this.sessions?.drainCompactions();
    } catch (error) {
      console.warn('[gateway] Failed to drain compactions:', summarizeErrorForLog(error));
    }

    try {
      await this.drainBackgroundOperations();
    } catch (error) {
      console.warn('[gateway] Failed to drain background operations:', summarizeErrorForLog(error));
    }

    try {
      await this.writeQueue?.drain();
    } catch (error) {
      console.warn('[gateway] Failed to drain write queue:', summarizeErrorForLog(error));
    }

    try {
      this.closeStore();
    } catch (error) {
      console.warn('[gateway] Failed to close store:', summarizeErrorForLog(error));
    }

    this.closed = true;
    if (firstError) {
      throw firstError;
    }
  }

  closeStore(): void {
    const vectorIndex = this.vectorIndex;
    this.vectorIndex = undefined;
    try {
      vectorIndex?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close vector index:', summarizeErrorForLog(error));
    }

    const keywordIndex = this.keywordIndex;
    this.keywordIndex = undefined;
    try {
      keywordIndex?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close keyword index:', summarizeErrorForLog(error));
    }

    const chunkStats = this.chunkStats;
    this.chunkStats = undefined;
    try {
      chunkStats?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close chunk stats:', summarizeErrorForLog(error));
    }

    const sessionIndex = this.sessionIndex;
    this.sessionIndex = undefined;
    try {
      sessionIndex?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close session index:', summarizeErrorForLog(error));
    }

    const factMirror = this.factMirror;
    this.factMirror = undefined;
    try {
      factMirror?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close fact mirror:', summarizeErrorForLog(error));
    }

    const eventSink = this.eventSink;
    this.eventSink = undefined;
    try {
      eventSink?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close event sink:', summarizeErrorForLog(error));
    }

    const store = this.store;
    this.store = undefined;
    try {
      store?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close memory store:', summarizeErrorForLog(error));
    }

    this.indexer = undefined;
    this.writeQueue = undefined;
  }

  async runTranscriptSweep(): Promise<NightlySweepResult> {
    if (this.stopping || this.sweepStopping || this.closed) return { scanned: false, added: 0 };
    if (this.sweepInFlight) return this.sweepInFlight;
    if (!this.sessions || !this.ledgerStore || !this.curiosity) {
      return { scanned: false, added: 0 };
    }
    const run = runNightlySweep(this.buildSweepDeps()).finally(() => { this.sweepInFlight = undefined; });
    this.sweepInFlight = run;
    return run;
  }

  launchBackgroundSweep(): void {
    if (this.stopping || this.closed) return;
    void this.runTranscriptSweep().catch((error) => {
      console.warn('[gateway] Transcript sweep failed:', summarizeErrorForLog(error));
    });
  }

  buildSweepDeps(): NightlySweepDeps {
    const sessions = this.sessions!;
    const ledgerStore = this.ledgerStore!;
    const curiosity = this.curiosity!;
    return {
      readDayLines: (date) => sessions.readDayFileLines(date),
      ledgerEntitiesForDay: async (date): Promise<LedgerDayRead> => {
        const key = date.toISOString().slice(0, 10);
        const set = new Set<string>();
        let incomplete = false;
        for (const type of Object.keys(TYPE_TO_FILE) as FactType[]) {
          let facts;
          try {
            facts = await ledgerStore.listAllOfType(type);
          } catch (e) {
            incomplete = true;
            console.warn('[gateway] transcript sweep ledger lane unreadable:', summarizeErrorForLog(e));
            continue;
          }
          for (const f of facts) {
            const created = new Date(f.createdAt);
            if (!Number.isNaN(created.getTime()) && created.toISOString().slice(0, 10) === key) {
              set.add(normalizeEntity(f.entity));
            }
          }
        }
        return { entities: set, incomplete } satisfies LedgerDayRead;
      },
      listCuriosity: () => curiosity.list(),
      addCuriosity: (item) => curiosity.add(item),
    };
  }

  trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(operation);
    this.inFlightOperations.add(promise);
    void promise.then(
      () => { this.inFlightOperations.delete(promise); },
      () => { this.inFlightOperations.delete(promise); },
    );
    return promise;
  }

  trackBackgroundOperation(label: string, operation: () => Promise<void>): void {
    if (this.stopping || this.closed) return;
    let promise: Promise<void>;
    try {
      promise = operation().catch((error) => {
        console.warn(`[gateway] ${label} failed:`, summarizeErrorForLog(error));
      });
    } catch (error) {
      promise = Promise.resolve();
      console.warn(`[gateway] ${label} failed:`, summarizeErrorForLog(error));
    }
    this.backgroundOperations.add(promise);
    void promise.then(
      () => { this.backgroundOperations.delete(promise); },
      () => { this.backgroundOperations.delete(promise); },
    );
  }

  queueBackgroundReindex(relativePath: string, operation: () => Promise<void>): void {
    const previous = this.reindexTails.get(relativePath) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.stopping || this.closed) return;
        await operation();
      })
      .catch((error) => {
        console.warn('[gateway] background reindex failed:', summarizeErrorForLog(error));
      })
      .finally(() => {
        if (this.reindexTails.get(relativePath) === task) {
          this.reindexTails.delete(relativePath);
        }
      });
    this.reindexTails.set(relativePath, task);
    this.backgroundOperations.add(task);
    void task.then(
      () => { this.backgroundOperations.delete(task); },
      () => { this.backgroundOperations.delete(task); },
    );
  }

  narrativeDeltaFor(relativePath: string, narrativeStore: NarrativeStore): NarrativeIndexDelta | undefined {
    const match = relativePath.match(/^memory\/(\d{4}-\d{2}-\d{2})\.md$/);
    return match ? narrativeStore.takeIndexDelta(match[1]) : undefined;
  }

  enqueuePendingIndexDelta(
    relativePath: string,
    sourceDelta: LedgerIndexDelta | NarrativeIndexDelta,
  ): void {
    const delta: MemoryIndexDelta = {
      hash: sourceDelta.hash,
      fingerprint: sourceDelta.fingerprint,
      chunks: sourceDelta.chunks.map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      })),
    };
    const pending = this.pendingIndexDeltas.get(relativePath) ?? [];
    pending.push(delta);
    this.pendingIndexDeltas.set(relativePath, pending);
  }

  takePendingIndexDelta(relativePath: string): MemoryIndexDelta | undefined {
    const pending = this.pendingIndexDeltas.get(relativePath);
    if (!pending || pending.length === 0) return undefined;
    this.pendingIndexDeltas.delete(relativePath);
    const last = pending[pending.length - 1];
    return {
      hash: last.hash,
      fingerprint: last.fingerprint,
      chunks: pending.flatMap(delta => delta.chunks),
    };
  }

  async drainInFlightOperations(): Promise<void> {
    while (this.inFlightOperations.size > 0) {
      await Promise.allSettled([...this.inFlightOperations]);
    }
  }

  async drainBackgroundOperations(): Promise<void> {
    while (this.backgroundOperations.size > 0) {
      await Promise.allSettled([...this.backgroundOperations]);
    }
  }

  async markIndexDirty(
    workspace: string,
    relativePath: string,
    store: SqliteStore,
    sourceHash?: string,
  ): Promise<void> {
    try {
      const hash = sourceHash ?? await this.hashFile(path.join(workspace, relativePath));
      store.upsertFileHash(relativePath, `embedding-partial:${hash}`);
    } catch (error) {
      console.warn('[gateway] Could not publish index dirty checkpoint:', summarizeErrorForLog(error));
    }
    this.dirtyIndexPaths.add(relativePath);
    this.persistDirtyIndexMarker();
  }

  async hashFile(filePath: string): Promise<string> {
    const digest = createHash('sha256');
    const input = fs.createReadStream(filePath);
    try {
      for await (const chunk of input) digest.update(chunk);
      return digest.digest('hex');
    } finally {
      input.destroy();
    }
  }

  clearIndexDirty(relativePath: string): void {
    this.dirtyIndexPaths.delete(relativePath);
    if (this.dirtyIndexPaths.size === 0) {
      const marker = this.dirtyIndexMarkerPath;
      if (!marker) return;
      try {
        fs.unlinkSync(marker);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[gateway] Could not clear index dirty marker:', summarizeErrorForLog(error));
        }
      }
      return;
    }
    this.persistDirtyIndexMarker();
  }

  clearAllDirtyIndexMarkers(): void {
    this.dirtyIndexPaths.clear();
    const marker = this.dirtyIndexMarkerPath;
    if (!marker) return;
    try {
      fs.unlinkSync(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[gateway] Could not clear index dirty marker:', summarizeErrorForLog(error));
      }
    }
  }

  persistDirtyIndexMarker(): void {
    const marker = this.dirtyIndexMarkerPath;
    if (!marker) return;
    try {
      secureWriteViaTmp(marker, JSON.stringify({ version: 1, paths: [...this.dirtyIndexPaths] }));
    } catch (error) {
      console.warn('[gateway] Could not persist index dirty marker:', summarizeErrorForLog(error));
    }
  }
}
