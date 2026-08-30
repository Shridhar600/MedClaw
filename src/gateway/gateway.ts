import * as path from 'path';
import type { AppConfig } from '../config/types';
import { ProfileRegistry } from '../profiles';
import type { ProfileId } from '../profiles';
import type { Channel, IncomingMessage } from '../channels/types';
import { TelegramChannel } from '../channels/telegram';
import { AgentLoop } from '../agent/agent-loop';
import type { PrepareSystem } from '../agent/agent-loop';
import { ContextAssembler } from '../agent/context';
import { ContextAssembler as ContextAssemblerV2 } from '../context2';
import { RecallEngine, DEFAULT_RECALL_CONFIG } from '../recall';
import { MemoryEngine } from '../memory/memory-engine';
import { ToolRegistry } from '../tools/registry';
import { LLMSemaphore, HeartbeatQueueFullError } from '../tools/semaphore';
import { createMemoryTools } from '../tools/memory-tools';
import { createMedicalTools } from '../tools/medical-tools';
import { createCronManageTool } from '../tools/cron-manage';
import { createHeartbeatManageTool } from '../tools/heartbeat-manage';
import { createLedgerTools } from '../tools/ledger-tools';
import { createEpisodeTools } from '../tools/episode-tools';
import { createSafetyTools } from '../tools/safety-tools';
import { WriteQueue, replayJournal } from '../profiles';
import { LedgerStore, NarrativeStore, SafetyView, EpisodeStore, CuriosityQueue, TYPE_TO_FILE } from '../memcore';
import type { FactType } from '../memcore';
import { SqliteFactMirror, SqliteEventSink, SqliteVecIndex, SqliteKeywordIndex, SqliteChunkStats, SqliteSessionIndex, ledgerFactToRecord, isRemoteEmbeddingBaseUrl } from '../indexstore';
import { createSessionTools } from '../tools/session-tools';
import { deprecatedSessionWarnings } from '../config/deprecations';
import type { EmbeddingPort } from '../ports';
import { systemClock } from '../ports';
import { CapturePipeline } from '../capture';
import { makeSafetyRenderer } from '../capture';
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
import { checkSystemReadiness, probeChatCompletion } from '../providers/healthcheck';
import type { ReadinessResult } from '../providers/healthcheck';
import type { LLMProvider } from '../providers/types';
import { checkProviderBindAddresses, verifyWorkspacePermissions, summarizeErrorForLog, secureMkdir } from '../security';

const EMERGENCY_PATTERN =
  /\b(chest pain|can't breathe|cannot breathe|difficulty breathing|stroke|heart attack|severe bleeding|suicidal|emergency)\b/i;
const EMERGENCY_RESPONSE =
  'This may be an emergency. Please contact local emergency services now or go to the nearest emergency department. If you can, ask someone nearby to stay with you while you get help.';
const UNRECOGNIZED_CHAT_RESPONSE =
  'This chat is not recognized. This is a private health assistant; new chats cannot be added over this channel.';
// PROD-P1-6: an empty or whitespace-only text message with no media gets a
// short canned reply — no agent run, no session write. Matches the test-cli's
// existing empty-input guard so the dev web UI exercises the same boundary.
const EMPTY_MESSAGE_RESPONSE = "I didn't catch any message. Send some text or an attachment and I'll take a look.";

export class Gateway {
  private config: AppConfig;
  private channel?: Channel;
  private agentLoop?: AgentLoop;
  private sessions?: SessionManager;
  private scheduler?: HeartbeatScheduler;
  private store?: SqliteStore;
  private factMirror?: SqliteFactMirror;
  private eventSink?: SqliteEventSink;
  private sessionIndex?: SqliteSessionIndex;
  // D3.4 (spec 14 §4 step 4): copies each compaction summary to today's daily log. Built in the memcore
  // block (needs the NarrativeStore + WriteQueue), wired into the SessionManager after it is constructed.
  private sessionSummarySink?: (anchoredSummary: string) => Promise<void>;
  private profileRegistry?: ProfileRegistry;
  private resolvedMemoryWorkspace?: string;
  private bootHealth?: { providers: ReadinessResult[]; telegram: ReadinessResult };
  // D9 observability (L-2): 'per-turn' when the recall + v2-assembler path is live; 'boot-cached'
  // when it failed to construct and chat fell back to the frozen boot prompt (recall effectively off).
  private promptMode: 'per-turn' | 'boot-cached' = 'boot-cached';
  private mainProvider?: LLMProvider;
  // v2 capture pipeline for the active profile (per-turn narrative capture hook, Task 13.3).
  private capturePipeline?: CapturePipeline;
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

    // P2b DD10 / D3.7: warn once at boot for any retired idle-reset config key still set to a
    // non-default value (they no longer trigger anything).
    for (const warning of deprecatedSessionWarnings(config.sessions)) {
      console.warn(`[gateway] Deprecated config: ${warning}`);
    }

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
    secureMkdir(path.dirname(dbPath));
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
    // A3.1b (v2-BL-2 = B1): the recall latency budget assumes LOCAL embeddings.
    if (isRemoteEmbeddingBaseUrl(config.providers.embeddings.baseUrl)) {
      console.warn('[gateway] Embeddings provider is remote — the recall latency budget (p50<=300ms / p95<=800ms) assumes local embeddings; expect higher per-turn recall latency.');
    }

    const search = new MemorySearch(store, embeddingProvider, config.memory.search.hybridWeights, profileId);

    // Providers
    const mainProvider = createProvider(config.providers.main);
    this.mainProvider = mainProvider; // #3: kept for the boot completion probe.

    // Tools
    const registry = new ToolRegistry(config.tools);
    // RES-P2-1: each tool group is registered independently so a failure in
    // one factory/dependency disables only that group and boot continues with
    // the remaining tools (resilience law: disable tool, log, continue).
    try {
      // E1.1: pass a lazy accessor for the fact mirror (built later in the memcore block). memory_search's
      // status:active filter reads it at execute time; if the memcore block never ran, it stays undefined
      // and the search degrades to no status filtering (backward-compat).
      for (const tool of createMemoryTools(memory, search, indexer, profileId, () => this.factMirror)) {
        registry.register(tool);
      }
    } catch (e) {
      console.warn('[gateway] Memory tools unavailable; continuing without them:', summarizeErrorForLog(e));
    }

    // Medical tools with medical provider
    try {
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
    } catch (e) {
      console.warn('[gateway] Medical tools unavailable; continuing without them:', summarizeErrorForLog(e));
    }

    // P2 C3 — the per-turn system-prompt supplier (recall + v2 assembly, D9). Assigned inside the
    // memcore block once the recall substrate is up; stays undefined (⇒ legacy boot-cached prompt)
    // if any of it fails to construct (resilience — a degraded recall path must not break the chat).
    let prepareSystem: PrepareSystem | undefined;

    // v2 memory core (P1): per-profile stores + capture pipeline + the ledger/episode/safety
    // tool groups + the per-turn narrative capture hook (Task 13). The stores share the
    // resolved profile workspace as their root (ledger/ , memory/ , SAFETY.md), so the legacy
    // assembler reads back what capture writes. Each block is individually try/caught (the P0
    // pattern): a broken store disables its group and boot continues. CuratedMemory/ScratchStore
    // land with their tools in a later phase — no P1 tool consumes them yet.
    try {
      const stateDir = path.join(memoryWorkspace, '.state');
      secureMkdir(stateDir);
      const journalPath = path.join(stateDir, 'write-queue.journal');
      const writeQueue = new WriteQueue({ journalPath });
      // A4 / 13.4: replay any ops journalled by a crash before serving (P1 logs stuck ops).
      try {
        await replayJournal(journalPath, (label) => {
          // A4: the SQLite mirror + search index are rebuilt from Markdown below (boot rebuild +
          // indexAll), so a stuck op's derived state self-heals — Markdown is the source of truth.
          console.warn('[gateway] stuck write-queue op recovered at boot (mirror/index rebuilt from Markdown):', label);
        });
      } catch (e) {
        console.warn('[gateway] write-queue journal replay failed:', summarizeErrorForLog(e));
      }

      const ledgerStore = new LedgerStore(memoryWorkspace);
      const narrativeStore = new NarrativeStore(memoryWorkspace);
      const safetyView = new SafetyView(memoryWorkspace);
      const episodeStore = new EpisodeStore(memoryWorkspace);
      const curiosityQueue = new CuriosityQueue(memoryWorkspace, undefined, undefined, profileId);
      const safetyRenderer = makeSafetyRenderer({
        render: (facts) => safetyView.render(facts),
        listSafetyRelevant: () => ledgerStore.listSafetyRelevant(),
      });

      // D3.4 (spec 14 §4 step 4 / A-M2): the compaction-summary → daily-log sink. The write goes through
      // the single-writer WriteQueue (background priority); the LLM that produced the summary already ran
      // outside the queue (B2). Best-effort — the SessionManager wraps the call so a failure never fails
      // compaction. Searchable/dreamable: the bullets (with their sessions/<file>#L<n> anchors) land in the
      // narrative daily log, read directly by dreaming and indexed on the next reconcile/boot.
      this.sessionSummarySink = async (anchoredSummary: string): Promise<void> => {
        const day = new Date().toISOString().slice(0, 10);
        await writeQueue.enqueue('background', {
          label: 'session-summary',
          run: () => narrativeStore.appendSessionSummary(day, anchoredSummary),
        });
      };

      // P2 A1/A2: the FactMirror (recall Stage 1 source) + the per-file re-derivation seam.
      // The mirror opens its OWN connection to the SAME search.db (M-3). It is fully rebuildable
      // from the ledger Markdown, so we rebuild it at boot (A4 self-heal — closes any crash window)
      // and re-derive per changed file after each capture write (M-2). Re-derivation runs OUTSIDE
      // the write-queue op (embeds off the single-writer lock — B2).
      const factMirror = new SqliteFactMirror({ dbPath });
      this.factMirror = factMirror;
      // A3: the event store, populated on metric/fact writes (Stage-3 correlation source, P5).
      const eventSink = new SqliteEventSink({ dbPath });
      this.eventSink = eventSink;
      const fileToType = new Map<string, FactType>(
        (Object.entries(TYPE_TO_FILE) as [FactType, string][]).map(([t, f]) => [f, t]),
      );
      const rederive = {
        rederive: async (relPaths: string[]): Promise<void> => {
          for (const rel of relPaths) {
            if (rel.startsWith('ledger/')) {
              const type = fileToType.get(rel.slice('ledger/'.length));
              if (type) {
                try {
                  const facts = await ledgerStore.listAllOfType(type);
                  await factMirror.upsert(facts.map(ledgerFactToRecord));
                } catch (e) {
                  console.warn('[gateway] fact-mirror re-derive failed (rebuildable at boot):', summarizeErrorForLog(e));
                }
              }
            }
            // Reindex the changed searchable file (ledger + narrative) so fresh writes are found
            // the SAME session (M-2). indexFile embeds; running it here (post-op) keeps embedding
            // off the write-queue lock (B2). Best-effort — a stale index degrades search, never crashes.
            try {
              await indexer.indexFile(rel);
            } catch (e) {
              console.warn('[gateway] incremental reindex failed for a changed file:', summarizeErrorForLog(e));
            }
          }
        },
      };

      // A4 (specs/13): rebuild the mirror from Markdown once at boot (parallels indexer.indexAll)
      // so any crash between a ledger write and its mirror upsert self-heals.
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
      });
      this.capturePipeline = pipeline;

      // REC (SB-8): boot-time SAFETY reconciliation. One full re-render from the
      // ledger closes the crash window between a ledger write and its render, and
      // turns a corrupt-type-file degradation into a self-healing event.
      try {
        await safetyRenderer.render(await ledgerStore.listSafetyRelevant());
      } catch (e) {
        console.warn('[gateway] boot SAFETY reconciliation failed (continuing):', summarizeErrorForLog(e));
      }

      // P2 C3 — recall + v2 assembler → the per-turn system-prompt supplier (D9). The recall READ
      // adapters open their own connections to the same search.db (M-3: store is the sole chunk
      // writer; these are read-mostly, chunk_stats excepted). A failure here degrades the CHAT path
      // to the legacy boot-cached prompt but keeps ledger/episode/safety tools + capture working.
      try {
        let cachedDim: number | null = null;
        const embeddingPort: EmbeddingPort = {
          embed: (texts) => Promise.all(texts.map((t) => embeddingProvider.embed(t))),
          dim: async () => {
            if (cachedDim === null) cachedDim = (await embeddingProvider.embed('')).length;
            return cachedDim;
          },
          modelId: async () => config.providers.embeddings.model,
        };
        const recallEngine = new RecallEngine({
          embedding: embeddingPort,
          vectorIndex: new SqliteVecIndex({ dbPath }),
          keywordIndex: new SqliteKeywordIndex({ dbPath }),
          factMirror,
          chunkStats: new SqliteChunkStats({ dbPath }),
          clock: systemClock,
          config: DEFAULT_RECALL_CONFIG,
        });
        const v2Assembler = new ContextAssemblerV2({
          reader: memory,
          safety: safetyView,
          maxChars: config.memory.bootstrapMaxChars,
          clock: systemClock,
        });
        prepareSystem = async (mode, userMessage) => {
          // Recall is best-effort: any failure degrades to no recall, never blocks the turn
          // (resilience). Assembly is NOT guarded here — a SAFETY-invariant violation must abort the
          // turn (medical-safety > resilience); the caller turns it into a safe fallback reply.
          let recall = null as Awaited<ReturnType<typeof recallEngine.run>> | null;
          try {
            // Only chat renders narrative hits; heartbeat/dream/subagent get Stage-1 ledger only —
            // running Stage-2 there would bump injected_count for chunks never shown (M-1).
            recall = await recallEngine.run({ profileId, userMessage }, { narrative: mode === 'chat' });
          } catch (e) {
            console.warn('[gateway] recall failed (assembling without recall):', summarizeErrorForLog(e));
            recall = null;
          }
          const report = await v2Assembler.assemble(profileId, mode, recall);
          return {
            messages: [{ role: 'system', content: report.content }],
            recordUsed: recall
              ? (ids) => recallEngine.recordUsage(ids, systemClock.now().toISOString())
              : undefined,
          };
        };
        console.log('[gateway] Per-turn recall + v2 context assembler ready (D9)');
      } catch (e) {
        console.warn('[gateway] Recall/v2-assembler unavailable; chat uses the boot-cached prompt:', summarizeErrorForLog(e));
      }

      // DIAB-06 side-effect lookup: prefer on-device medgemma, fall back to main (resilience).
      let sideEffectProvider: LLMProvider = mainProvider;
      try {
        sideEffectProvider = createProvider(config.providers.medical);
      } catch (e) {
        console.warn('[gateway] Medical provider for side-effect lookup unavailable; using main:', summarizeErrorForLog(e));
      }

      try {
        for (const tool of createLedgerTools({
          pipeline,
          ledger: ledgerStore,
          safety: safetyRenderer,
          queue: writeQueue,
          narrative: narrativeStore,
          sideEffectLookup: (entity) => this.lookupSideEffects(sideEffectProvider, entity),
          // CONTRA-09: confirm/remove bypass the capture pipeline — re-derive the recall mirror +
          // index for the changed ledger file so a confirmed retraction leaves the next turn's context.
          afterLedgerMutation: (type) => rederive.rederive([`ledger/${TYPE_TO_FILE[type]}`]),
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

    // Context. The legacy assembler still runs once at boot: it fires the SAFETY non-omission
    // invariant (a broken non-empty SAFETY.md aborts boot — medical-safety > resilience) and yields
    // the fallback system prompt used when the v2 recall path is unavailable. The live chat path
    // uses `prepareSystem` (per-turn recall + v2 assembly, D9) when it was constructed above.
    const assembler = new ContextAssembler(memory, config.memory.bootstrapMaxChars, profileId);
    const systemMessages = await assembler.buildSystemMessages();

    // Agent
    const semaphore = new LLMSemaphore();
    this.agentLoop = new AgentLoop(mainProvider, registry, prepareSystem ?? systemMessages, config.agent, semaphore);
    this.promptMode = prepareSystem ? 'per-turn' : 'boot-cached';

    // Sessions
    // Path resolution stays here (Gateway) rather than inside SessionManager
    // itself: SessionManager has no other dependency on the profiles module,
    // and keeping it that way avoids adding module coupling for a value the
    // caller already has to compute (ProfileRegistry.profileSessions). Only
    // derived when a profiles config was actually supplied; otherwise
    // SessionManager keeps its own legacy default.
    const sessionsPath = this.profileRegistry ? this.profileRegistry.profileSessions(profileId) : undefined;
    this.sessions = new SessionManager({
      sessionsPath,
      softResetMinutes: config.sessions.softResetAfterMinutes,
      hardResetMinutes: config.sessions.hardResetAfterMinutes,
      provider: mainProvider,
      toolRegistry: registry,
      compaction: config.sessions.compaction,
      // P2b spec 14 §3: real-token window triggers + the model's context window (DD4).
      window: config.sessions.window,
      contextWindow: config.providers.main.contextWindow,
      profileId,
      // Wave-D panel X-1/X-2 (founder decision 2026-08-30): the perpetual THREAD is per-chat (health
      // MEMORY stays per-profile). Every chat gets its own namespaced archive + window + index scope so a
      // second chat on a profile can never resume another chat's summary or search its turns. spec 14 §2
      // "per-profile thread" holds in the common one-chat-per-profile case (P0 auto-pair).
      perChatArchive: true,
    });
    // F8: run compaction LLM calls at 'background' priority (below user + heartbeat). prepareHistory
    // (where compaction happens) runs before AgentLoop acquires the semaphore, so this never deadlocks.
    this.sessions.setBackgroundRunner((fn) => semaphore.run('background', fn));
    // D3.4 (spec 14 §4 step 4): copy each compaction summary to the daily log (if the memcore block wired
    // the sink; absent ⇒ compaction still runs, just without the daily-log copy).
    if (this.sessionSummarySink) {
      this.sessions.setSummarySink(this.sessionSummarySink);
    }

    // Wave D-2 (PLAT-20): session_search FTS over the append-only day-file archive — the losslessness
    // substrate for prune (D3). The index opens its OWN connection to the profile search.db (M-3) and
    // rebuilds from the day files when empty (post-migration / dropped table, A-MF4). It is injected into
    // the SessionManager for incremental per-turn indexing and exposed as the session_search tool. The
    // AgentLoop reads the registry live each turn, so registering here (after its construction) is fine.
    // Individually wrapped (RES-P2-1): any failure disables search and boot continues with the rest.
    try {
      const sessionIndex = new SqliteSessionIndex({ dbPath, sessionsDir: this.sessions.sessionsDir });
      this.sessionIndex = sessionIndex;
      this.sessions.setTurnIndex(sessionIndex);
      for (const tool of createSessionTools({ index: sessionIndex })) {
        registry.register(tool);
      }
    } catch (e) {
      console.warn('[gateway] session_search unavailable; continuing without it:', summarizeErrorForLog(e));
    }

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
      try {
        registry.register(createCronManageTool(this.scheduler, this.getEffectiveWorkspace()));
        registry.register(createHeartbeatManageTool(this.scheduler, this.getEffectiveWorkspace()));
      } catch (e) {
        console.warn('[gateway] Cron/heartbeat tools unavailable; continuing without them:', summarizeErrorForLog(e));
      }
    }

    await this.runBootHealthchecks();
    this.runSecurityChecks();

    console.log('[gateway] Redacted is running.');
  }

  /**
   * Per-turn narrative capture (Task 13.3 / F4 / CHAT-06). Raw user text is ALWAYS captured
   * losslessly through the profile's CapturePipeline — deterministic, agent-independent.
   * Structured ledger entries stay agent-initiated via tools. Capture never blocks the reply:
   * a failure warns-and-continues (resilience). Empty text and media-only turns are skipped.
   */
  private async captureUserTurn(chatId: string, text: string): Promise<void> {
    const pipeline = this.capturePipeline;
    if (!pipeline || text.trim().length === 0) return;
    try {
      await pipeline.ingest({
        profileId: (this.getProfileForChat(chatId) ?? 'default') as string,
        source: 'chat',
        kind: 'narrative-note',
        payload: { text },
      });
    } catch (e) {
      console.warn('[gateway] per-turn narrative capture failed (continuing):', summarizeErrorForLog(e));
    }
  }

  /**
   * DIAB-06 (D1): resolve a medication's known side effects via the medical provider before
   * a ledger write. Fully guarded — any failure returns [] so the field is never absent, and
   * the medication name (health content) is never logged.
   */
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

  async handleTestMessage(chatId: string, text: string): Promise<string> {
    // PROD-P1-6: empty/whitespace-only text → short canned reply, no agent run,
    // no session write (mirrors the channel path in handleMessage).
    if (text.trim().length === 0) {
      return EMPTY_MESSAGE_RESPONSE;
    }

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

    // forka #4: /new must reset the session here too (parity with the channel
    // path in handleMessage). Previously it fell through to the agent loop.
    if (text.trim() === '/new') {
      await this.sessions!.resetSession(chatId);
      return 'Starting fresh session. Your health memory is preserved.';
    }

    // P2b DD9: /compact forces the spec-14 §4 compaction pipeline on demand.
    if (text.trim() === '/compact') {
      await this.sessions!.runCompaction(chatId);
      return 'Compacted the conversation. Older turns are summarized; recent context is kept. Nothing is lost — ask me to look anything up.';
    }

    const emergency = this.handleEmergencyInput(text);
    if (emergency) {
      // CAP (M5): emergency utterances are the highest-value health data —
      // capture the raw text BEFORE the canned-response early-return.
      await this.captureUserTurn(chatId, text);
      // C-2/H9: persistence is best-effort — a failed archive must NEVER suppress emergency guidance
      // (medical-safety: reaching the user wins; divergence is logged sanitized). Mirrors handleMessage.
      try {
        await this.sessions?.recordTurn(chatId, [
          { role: 'user', content: text },
          { role: 'assistant', content: emergency },
        ]);
      } catch (e) {
        console.error('[gateway] Failed to persist emergency turn (test path; sending guidance anyway):', summarizeErrorForLog(e));
      }
      return emergency;
    }

    const onboarding = await this.handleOnboarding(chatId, text);
    if (onboarding) {
      // CAP (M6-sec): onboarding answers carry structured health facts (meds,
      // conditions) — captured losslessly like every other turn.
      await this.captureUserTurn(chatId, text);
      return onboarding;
    }

    // Lossless per-turn capture (F4) — always, before the agent run.
    await this.captureUserTurn(chatId, text);

    // M-3: guard the agent run exactly like handleMessage — the CLI/e2e path must DEGRADE to the
    // canned fallback, never throw out of the handler (mirror-sync law).
    let result: Awaited<ReturnType<AgentLoop['run']>>;
    try {
      const history = await this.sessions!.prepareHistory(chatId);
      result = await this.agentLoop!.run(text, history, { chatId, mode: 'chat' });
    } catch (e) {
      console.error('[gateway] Agent error (test path):', summarizeErrorForLog(e));
      return "I'm having trouble right now. Please try again in a moment.";
    }
    // C-2/H9: post-agent persistence is best-effort — mirror handleMessage's guarded pre-send persistence
    // so the CLI/e2e path DEGRADES (still returns the answer) instead of throwing out of the handler.
    try {
      await this.sessions!.recordTurn(chatId, [
        { role: 'user', content: text },
        ...result.trace,
      ]);
      // Spec 14 §3: feed the real window-fill signal back so the NEXT turn's prepareHistory can trigger.
      await this.sessions!.recordPromptUsage(chatId, result.lastPromptTokens);
    } catch (e) {
      console.error('[gateway] Post-agent persistence error (test path; returning answer anyway):', summarizeErrorForLog(e));
    }
    await this.debouncedReconcile(chatId);
    return result.text;
  }

  private async handleMessage(incoming: IncomingMessage): Promise<void> {
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

    // P2b DD9: /compact forces the spec-14 §4 compaction pipeline on demand.
    if (text.trim() === '/compact') {
      await this.sessions!.runCompaction(chatId);
      await this.channel!.send(chatId, { text: 'Compacted the conversation. Older turns are summarized; recent context is kept. Nothing is lost — ask me to look anything up.' });
      return;
    }

    const emergency = this.handleEmergencyInput(text);
    if (emergency) {
      // CAP (M5): capture raw text before the early-return (parity with
      // handleTestMessage). Emergency utterances are the highest-value data.
      await this.captureUserTurn(chatId, text);
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
        await this.sessions!.recordTurn(chatId, emergencyTurn);
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
      return;
    }

    if (incoming.mediaError) {
      // M-3 / F4 parity: this was the one branch that skipped lossless capture. Capture the raw
      // caption first (no-ops on an empty caption) so a failed upload never loses the user's words.
      await this.captureUserTurn(chatId, text);
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
      // CAP (M6-sec): parity with handleTestMessage — capture before the return.
      await this.captureUserTurn(chatId, text);
      await this.channel!.send(chatId, { text: onboarding });
      return;
    }

    // Emergency check after onboarding completes
    const postOnboardingEmergency = this.handleEmergencyInput(text);
    if (postOnboardingEmergency) {
      // CAP (M5): parity — raw text lands in the lossless lane here too.
      await this.captureUserTurn(chatId, text);
      // Persist-first (RES-P0-4), mirroring the early emergency branch above.
      try {
        await this.sessions!.recordTurn(chatId, [
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
      return;
    }

    // Lossless per-turn capture (F4) — the RAW user text, always, before the agent run.
    await this.captureUserTurn(chatId, text);

    let result: Awaited<ReturnType<AgentLoop['run']>>;
    try {
      const history = await this.sessions!.prepareHistory(chatId);
      result = await this.agentLoop!.run(agentInput, history, { chatId, mode: 'chat' });
    } catch (e) {
      console.error('[gateway] Agent error:', summarizeErrorForLog(e));
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
      await this.sessions!.recordTurn(chatId, [
        { role: 'user', content: agentInput },
        ...result.trace,
      ]);
      // Spec 14 §3: feed the real window-fill signal back so the NEXT turn's prepareHistory can trigger.
      await this.sessions!.recordPromptUsage(chatId, result.lastPromptTokens);
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
    for (const timer of this.reconcileTimers.values()) {
      clearTimeout(timer);
    }
    this.reconcileTimers.clear();
    let firstError: unknown;
    try {
      // Drain any in-flight background compaction BEFORE closing the store so its window/summary write
      // completes against an open DB and never outlives the process (resilience: no work after stop()).
      await this.sessions?.drainCompactions();
    } catch (error) {
      console.warn('[gateway] Failed to drain compactions:', summarizeErrorForLog(error));
    }
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
      const result = await this.agentLoop!.run(input, history, { chatId: job.chatId, origin: 'heartbeat', mode: 'heartbeat' });
      if (result.text === HEARTBEAT_NOOP) {
        await this.sessions!.recordTurn(job.chatId, [
          { role: 'user', content: input },
          ...result.trace,
        ]);
        await this.sessions!.recordPromptUsage(job.chatId, result.lastPromptTokens);
        await this.scheduler?.recordOutcome(job.id, 'noop');
        await this.reconcileHeartbeatPolicies(job.chatId);
        return;
      }

      await this.channel!.send(job.chatId, { text: result.text });
      await this.sessions!.recordTurn(job.chatId, [
        { role: 'user', content: input },
        ...result.trace,
      ]);
      await this.sessions!.recordPromptUsage(job.chatId, result.lastPromptTokens);
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
    // F11: only READ which chat to reconcile heartbeat policies for — never
    // auto-pair here. Auto-pair is a first-CONTACT bridge (getProfileForChat on
    // a real inbound message). Consuming it at boot for a stale session/job
    // chatId (e.g. pairing data lost, session JSONL survived) would permanently
    // close pairing before the owner's first message — and could hand a
    // leaked-token stranger the default profile. reconcileHeartbeatPolicies and
    // handleScheduledJob use the chatId directly / re-check pairing themselves.
    const sessionChatId = this.sessions?.getMostRecentChatId();
    if (sessionChatId) {
      return sessionChatId;
    }

    const jobs = await this.scheduler!.listJobs();
    return jobs.find((job) => job.chatId !== '__startup__')?.chatId;
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
      // C-2/H9: best-effort persistence — a failed archive must not reject the onboarding response.
      try {
        await this.sessions?.recordTurn(chatId, [
          { role: 'user', content: input },
          { role: 'assistant', content: result.response },
        ]);
      } catch (e) {
        console.error('[gateway] Failed to persist onboarding turn (returning response anyway):', summarizeErrorForLog(e));
      }
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
    // C-2/H9: best-effort persistence — a failed archive must not reject the onboarding response.
    try {
      await this.sessions?.recordTurn(chatId, [
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
    try {
      this.factMirror?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close fact mirror:', summarizeErrorForLog(error));
    } finally {
      this.factMirror = undefined;
    }
    try {
      this.eventSink?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close event sink:', summarizeErrorForLog(error));
    } finally {
      this.eventSink = undefined;
    }
    try {
      this.sessionIndex?.close();
    } catch (error) {
      console.warn('[gateway] Failed to close session index:', summarizeErrorForLog(error));
    } finally {
      this.sessionIndex = undefined;
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
      // #3: config/reachability checks alone over-report OK — a key-present but
      // subscription-blocked or tool-incapable main model still shows "OK". Fold
      // a real, tool-bearing completion probe into the main-provider entry so
      // /status reflects whether the model actually answers.
      await this.probeMainCompletionInto(healthResults);
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

  // #3: run the live completion probe on the MAIN provider only (it is the one
  // that must support tool calling) and fold the result into its readiness
  // entry. Skips when the config-level check already failed the main provider
  // (nothing to probe) or the provider is unavailable. Never throws.
  private async probeMainCompletionInto(
    healthResults: { providers: ReadinessResult[]; telegram: ReadinessResult },
  ): Promise<void> {
    const idx = healthResults.providers.findIndex((p) => p.label === 'main provider');
    if (idx < 0 || !this.mainProvider || !healthResults.providers[idx].ready) {
      return;
    }
    const base = healthResults.providers[idx];
    const completion = await probeChatCompletion(this.mainProvider, { label: 'main provider' });
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
    const lines = [
      'System Health:',
      ...h.providers.map((p) => `  ${p.label}: ${p.ready ? 'OK' : 'FAIL'}`),
      `  telegram: ${h.telegram.ready ? 'OK' : 'FAIL'}`,
      `  prompt: ${this.promptMode}${this.promptMode === 'boot-cached' ? ' (recall off — degraded)' : ''}`,
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

