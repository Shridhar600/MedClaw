import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message, ToolSchema } from '../providers/types';
import type { LLMProvider, LLMResponse } from '../providers/types';
import type { ToolRegistry } from '../tools/registry';
import { type RotationConfig } from '../scheduler/rotation';
import { DaemonShutdownError } from '../shared/errors';
import { DEFAULT_SESSION_WINDOW } from '../config';
import {
  summarizeErrorForLog,
  secureMkdir,
  secureAppend,
  PathContainmentError,
  resolveContainedPath,
} from '../security';
import {
  dateKey,
  countDayFileLines,
  deriveWindowAnchor,
  isArchiveTailCurrent,
  latestDayFileTail,
  listDayFiles,
  anchorBefore,
  readLinesAfter,
  latestDayFileEof,
  resolveWindow,
  saveWindow,
  type Anchor,
  type ArchiveTail,
  type SessionWindow,
} from './session-window';

const SUMMARY_PREFIX = '[Previous conversation summary]\n';

const MAX_DAY_FILE_READ_BYTES = 64 * 1024 * 1024;

interface Session {
  chatId: string;
  history: Message[];
  /** One physical archive cursor per history message; summary messages carry no cursor. */
  historyAnchors: Array<Anchor | undefined>;
  lastActiveAt: Date;
}

export type JsonlOrigin = 'chat' | 'heartbeat' | 'system';

interface JsonlEntry {
  timestamp: string;
  role: Message['role'];
  content: string | null;
  chatId: string;
  origin?: JsonlOrigin;
  tool_call_id?: string;
  tool_calls?: Message['tool_calls'];
  // Alternate camelCase field names, accepted on read.
  toolCallId?: string;
  toolCalls?: Message['tool_calls'];
  // Alternate persisted field names, accepted on read.
  toolName?: string;
  toolResult?: string;
}

interface CompactionConfig {
  enabled: boolean;
  memoryFlush: boolean;
  keepRecentTurns: number;
}

interface WindowConfig {
  pruneAtPercent: number;
  compactAtPercent: number;
  emergencyAtPercent: number;
  keepRecentTurns: number;
}

interface CompactionSnapshot {
  historyRef: Message[];
  historyAnchorsRef: Array<Anchor | undefined>;
  split: number;
  oldSummary: string;
  olderReal: Message[];
  rangeAnchors: Anchor[];
}

export interface SessionManagerOptions {
  sessionsPath?: string;
  provider?: LLMProvider;
  toolRegistry?: ToolRegistry;
  compaction?: CompactionConfig;
  /** Real-token window triggers (defaults 35/50/80/10 when absent). */
  window?: WindowConfig;
  /** The model's context window in tokens; falls back to `contextWindowFor` when unset. */
  contextWindow?: number;
  profileId?: string;
  rotationConfig?: Partial<RotationConfig>;
  perChatArchive?: boolean;
}

export interface SessionTurnIndexer {
  indexTurn(chatId: string, file: string, line: number, role: string, ts: string, content: string): void;
  /** Durably flag a swallowed incremental-index failure so the next boot reconciles the hole. */
  markDirty?(): void;
  /** Rebuild derived rows after records are appended at new physical anchors. */
  reconcileFromDayFiles?(): void;
}

function isTransientLlmError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true; // no status ⇒ network-ish ⇒ transient
  return status === 429 || status >= 500;
}

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

const FALLBACK_SYSTEM_OVERHEAD_TOKENS = 3000;

export type WindowTrigger = 'none' | 'prune' | 'compact' | 'emergency';

export function windowTriggerFor(
  fillPercent: number,
  thresholds: { pruneAtPercent: number; compactAtPercent: number; emergencyAtPercent: number },
): WindowTrigger {
  if (fillPercent >= thresholds.emergencyAtPercent) return 'emergency';
  if (fillPercent >= thresholds.compactAtPercent) return 'compact';
  if (fillPercent >= thresholds.pruneAtPercent) return 'prune';
  return 'none';
}

export function contextWindowFor(model?: string): number {
  if (!model) return 8192;
  const m = model.toLowerCase();
  if (/^gpt-5/.test(m) || /^o[1-9]/.test(m)) return 128000;
  if (m.includes('gpt-4o') || m.includes('gpt-4.1')) return 128000;
  if (m.includes('llama3.2')) return 128000;
  if (m.includes('kimi')) return 262144; // 256K context (shipped default main model)
  return 8192; // medgemma / unknown
}

export function turnAwareSplit(history: Message[], keepTurns: number): number {
  if (keepTurns <= 0) return history.length;
  const userIdx: number[] = [];
  for (let i = 0; i < history.length; i++) if (history[i].role === 'user') userIdx.push(i);
  if (userIdx.length <= keepTurns) return 0; // fewer complete turns than we keep ⇒ keep all
  return userIdx[userIdx.length - keepTurns]; // the user message that starts the last `keepTurns` turns
}

function stripModelAnchors(text: string): string {
  return text.replace(/\s*\(?sessions\/\S+#L\d+\)?/g, '');
}

export function stripOrphanToolMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const prev = out[out.length - 1];
      const inValidGroup =
        !!prev &&
        ((prev.role === 'assistant' && !!prev.tool_calls && prev.tool_calls.length > 0) ||
          prev.role === 'tool');
      if (inValidGroup) {
        out.push(msg);
      }
      continue; // orphan tool -> drop
    }
    out.push(msg);
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

interface AnchoredMessage {
  message: Message;
  anchor?: Anchor;
}

/** Keep the physical anchor paired with a message while applying the OpenAI tool-group sanitizer. */
function stripOrphanToolMessagesWithAnchors(entries: AnchoredMessage[]): AnchoredMessage[] {
  const out: AnchoredMessage[] = [];
  for (const entry of entries) {
    if (entry.message.role === 'tool') {
      const previous = out[out.length - 1]?.message;
      const inValidGroup =
        !!previous &&
        ((previous.role === 'assistant' && !!previous.tool_calls && previous.tool_calls.length > 0) ||
          previous.role === 'tool');
      if (inValidGroup) out.push(entry);
      continue;
    }
    out.push(entry);
  }
  while (out.length > 0) {
    const last = out[out.length - 1].message;
    if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

export const PRUNED_TOOL_MARKER = '[tool result pruned — session_search to retrieve]';

const PRUNE_LAST_TURNS = 5;

export function pruneToolResults(history: Message[], keepTurns: number): Message[] {
  if (keepTurns <= 0) return history;
  const userIdx: number[] = [];
  for (let i = 0; i < history.length; i++) if (history[i].role === 'user') userIdx.push(i);
  if (userIdx.length <= keepTurns) return history; // no region older than the last `keepTurns` turns
  const boundary = userIdx[userIdx.length - keepTurns]; // start of the last `keepTurns` turns
  return history.map((m, i) =>
    i < boundary && m.role === 'tool' ? { ...m, content: PRUNED_TOOL_MARKER } : m,
  );
}

export function anchorSummaryBullets(summaryText: string, rangeAnchors: Anchor[]): string {
  if (rangeAnchors.length === 0) return summaryText;
  let bulletIdx = 0;
  return summaryText
    .split('\n')
    .map((line) => {
      if (line.trim().length === 0) return line;
      if (/sessions\/\S+#L\d+/.test(line)) return line;
      const a = rangeAnchors[Math.min(bulletIdx, rangeAnchors.length - 1)];
      bulletIdx++;
      return `${line} (sessions/${a.file}#L${a.line})`;
    })
    .join('\n');
}

function dayFileEndsWithoutNewline(filePath: string): boolean {
  let fd: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    if (size === 0) return false;
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a; // 0x0a === '\n'
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private sessionsPath: string;
  private operationQueues: Map<string, Array<() => Promise<void>>> = new Map();
  private readonly chatsWithUserActivity: Set<string> = new Set();
  private readonly llmProvider?: LLMProvider;
  private readonly toolRegistry?: ToolRegistry;
  private readonly compactionConfig?: CompactionConfig;
  private readonly windowConfig?: WindowConfig;
  private readonly contextWindow?: number;
  private readonly profileId: string;
  private readonly lastPromptTokensByChat: Map<string, { tokens: number; estimated: boolean; triggered?: boolean }> = new Map();
  // The in-flight background compaction per chat, so a second trigger never starts a second pipeline.
  private readonly compactionInFlight: Map<string, Promise<void>> = new Map();
  private readonly rotationConfig?: Partial<RotationConfig>;
  private readonly perChatArchive: boolean;
  private readonly dayFileLineCounts: Map<string, number> = new Map();
  private readonly archiveTailsByDir: Map<string, ArchiveTail> = new Map();
  private runBackground?: <T>(fn: () => Promise<T>) => Promise<T>;
  private turnIndex?: SessionTurnIndexer;
  // A summary copy is durable pending work until the sink and the cleared window state both commit.
  private readonly pendingSummariesByChat: Map<string, string> = new Map();
  private isShutdown: () => boolean = () => false;

  /** Wire compaction LLM calls through the semaphore at background priority. */
  setBackgroundRunner(run: <T>(fn: () => Promise<T>) => Promise<T>): void {
    this.runBackground = run;
  }

  setShutdownGate(isShutdown: () => boolean): void {
    this.isShutdown = isShutdown;
  }

  /** Reject a late write before it touches disk or the op queue. */
  private assertNotShutdown(label: string): void {
    if (this.isShutdown()) {
      throw new DaemonShutdownError(label);
    }
  }

  /** Wire the session_search FTS index for incremental per-turn indexing. */
  setTurnIndex(index: SessionTurnIndexer): void {
    this.turnIndex = index;
  }

  private summarySink?: (chatId: string, anchoredSummary: string) => Promise<void>;

  /** Wire the compaction-summary sink. */
  setSummarySink(sink: (chatId: string, anchoredSummary: string) => Promise<void>): void {
    this.summarySink = sink;
  }

  /** Retry summary copies that were durably attached to a window but not yet accepted by the sink. */
  async retryPendingSummaries(): Promise<void> {
    if (!this.summarySink) return;
    for (const chatId of [...this.pendingSummariesByChat.keys()]) {
      try {
        await this.enqueue(chatId, async () => this.flushPendingSummaryLocked(chatId));
      } catch (e) {
        console.warn('[session] pending summary retry failed, continuing:', summarizeErrorForLog(e));
      }
    }
  }

  /** Run while the per-chat queue is held; failures leave the pending marker intact for a later retry. */
  private async flushPendingSummaryLocked(chatId: string): Promise<void> {
    const summary = this.pendingSummariesByChat.get(chatId);
    if (!summary || !this.summarySink) return;
    try {
      await this.summarySink(chatId, summary);
    } catch (e) {
      console.warn(`[session:${chatId}] Session-summary daily-log copy failed:`, summarizeErrorForLog(e));
      return;
    }

    this.pendingSummariesByChat.delete(chatId);
    if (!this.saveWindowFor(chatId)) this.pendingSummariesByChat.set(chatId, summary);
  }

  /** The resolved day-file archive root — the Gateway builds the search index over this same directory. */
  get sessionsDir(): string {
    return this.sessionsPath;
  }

  readDayFileLines(date: Date): string[] {
    const day = `${dateKey(date)}.jsonl`;
    const files: string[] = [];
    if (this.perChatArchive) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(this.sessionsPath, { withFileTypes: true });
      } catch {
        entries = []; // sessions dir unreadable — nothing to sweep
      }
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      for (const name of dirs) {
        try {
          files.push(resolveContainedPath(this.sessionsPath, name, day));
        } catch (e) {
          console.warn('[session] skipping unsafe chat archive lane:', summarizeErrorForLog(e));
        }
      }
    } else {
      try {
        files.push(resolveContainedPath(this.sessionsPath, day));
      } catch (e) {
        console.warn('[session] skipping unsafe day-file path:', summarizeErrorForLog(e));
      }
    }
    const lines: string[] = [];
    for (const f of files) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(f); // lstat: never follows a symlink
      } catch {
        continue; // missing — skip
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_DAY_FILE_READ_BYTES) {
        console.warn(`[session] day file exceeds the sweep read budget, skipping: ${path.basename(f)}`);
        continue;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(f, 'utf-8');
      } catch {
        continue; // unreadable — skip
      }
      for (const line of raw.split('\n')) {
        if (line.trim() !== '') lines.push(line);
      }
    }
    return lines;
  }

  private runLLM<T>(fn: () => Promise<T>): Promise<T> {
    return this.runBackground ? this.runBackground(fn) : fn();
  }

  private compactionRetry = { attempts: 3, backoffMs: 1500 };

  private async runLLMWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const { attempts, backoffMs } = this.compactionRetry;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.runLLM(fn);
      } catch (e) {
        lastError = e;
        if (!isTransientLlmError(e) || attempt >= attempts) throw e;
        // Sanitized frame only — transcript content can echo PHI.
        console.warn(`[session] ${label} LLM call failed (attempt ${attempt}/${attempts}), retrying:`, summarizeErrorForLog(e));
        await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
      }
    }
    throw lastError;
  }

  constructor(options?: SessionManagerOptions);
  constructor(
    sessionsPath?: string,
    llmProvider?: LLMProvider,
    toolRegistry?: ToolRegistry,
    compactionConfig?: CompactionConfig,
    profileId?: string,
    rotationConfig?: Partial<RotationConfig>,
  );
  constructor(
    a?: SessionManagerOptions | string,
    llmProvider?: LLMProvider,
    toolRegistry?: ToolRegistry,
    compactionConfig?: CompactionConfig,
    profileId?: string,
    rotationConfig?: Partial<RotationConfig>,
  ) {
    const opts: SessionManagerOptions =
      typeof a === 'string' || a === undefined
        ? {
            sessionsPath: a,
            provider: llmProvider,
            toolRegistry,
            compaction: compactionConfig,
            profileId,
            rotationConfig,
          }
        : a;
    this.sessionsPath = opts.sessionsPath ?? path.join(os.homedir(), '.redacted', 'sessions');
    this.llmProvider = opts.provider;
    this.toolRegistry = opts.toolRegistry;
    this.compactionConfig = opts.compaction;
    this.windowConfig = opts.window;
    this.contextWindow = opts.contextWindow;
    this.profileId = opts.profileId ?? 'default';
    this.rotationConfig = opts.rotationConfig;
    this.perChatArchive = opts.perChatArchive ?? false;
    secureMkdir(this.sessionsPath);
    this.resumeSessions();
  }

  getOrCreateSessionState(chatId: string): Session {
    const existing = this.sessions.get(chatId);
    if (existing) {
      return existing;
    }
    const created: Session = {
      chatId,
      history: [],
      historyAnchors: [],
      lastActiveAt: new Date(),
    };
    this.sessions.set(chatId, created);
    return created;
  }

  getHistory(chatId: string): Message[] {
    return this.sessions.get(chatId)?.history ?? [];
  }

  getLastActiveAt(chatId: string): Date | undefined {
    if (!this.chatsWithUserActivity.has(chatId)) return undefined;
    return this.sessions.get(chatId)?.lastActiveAt;
  }

  getMostRecentChatId(): string | undefined {
    let latest: Session | undefined;
    for (const session of this.sessions.values()) {
      if (!this.chatsWithUserActivity.has(session.chatId)) continue;
      if (!latest || session.lastActiveAt.getTime() > latest.lastActiveAt.getTime()) {
        latest = session;
      }
    }
    return latest?.chatId;
  }

  async prepareHistory(chatId: string): Promise<Message[]> {
    const trigger = await this.enqueue(chatId, async () => {
      const session = this.sessions.get(chatId);
      if (!session) return 'none' as WindowTrigger;
      const t = this.evaluateWindowTrigger(chatId);
      if (t !== 'none') {
        const reading = this.lastPromptTokensByChat.get(chatId);
        if (reading) reading.triggered = true;
        if (t === 'prune') {
          // Prune: no LLM, synchronous in this queued op (lossless; day file untouched).
          session.history = pruneToolResults(session.history, PRUNE_LAST_TURNS);
          this.saveWindowFor(chatId);
        }
      }
      return t;
    });

    if (trigger === 'compact') {
      this.startBackgroundCompaction(chatId);
    } else if (trigger === 'emergency') {
      // Emergency: reduce before the turn proceeds (awaited). Always runs, even with compaction disabled.
      await this.runEmergencyCompaction(chatId);
    }

    return this.enqueue(chatId, async () =>
      stripOrphanToolMessages([...(this.sessions.get(chatId)?.history ?? [])]),
    );
  }

  private evaluateWindowTrigger(chatId: string): WindowTrigger {
    const reading = this.lastPromptTokensByChat.get(chatId);
    if (!reading || reading.triggered) return 'none';
    return windowTriggerFor(this.windowFillPercent(chatId), this.windowThresholds());
  }

  private guardedCompaction(chatId: string): Promise<void> {
    const existing = this.compactionInFlight.get(chatId);
    if (existing) return existing;
    const p = this.doCompaction(chatId)
      .catch((e) => console.warn(`[session:${chatId}] compaction failed:`, summarizeErrorForLog(e)))
      .finally(() => this.compactionInFlight.delete(chatId));
    this.compactionInFlight.set(chatId, p);
    return p;
  }

  private startBackgroundCompaction(chatId: string): void {
    if (this.compactionConfig?.enabled === false) return;
    void this.guardedCompaction(chatId);
  }

  private async runEmergencyCompaction(chatId: string): Promise<void> {
    if (this.compactionConfig?.enabled !== false && this.llmProvider) {
      await this.guardedCompaction(chatId);
    }
    await this.enqueue(chatId, async () => {
      this.emergencyTruncate(chatId);
      this.saveWindowFor(chatId);
    });
  }

  private emergencyTruncate(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    const keepRecent = Math.max(1, this.windowThresholds().keepRecentTurns);
    const first = session.history[0];
    const hasSummary = !!first && first.role === 'system'
      && typeof first.content === 'string' && first.content.startsWith(SUMMARY_PREFIX);
    const entries = session.history.map((message, index) => ({
      message,
      anchor: session.historyAnchors[index],
    }));
    const summaryPrefix = hasSummary ? entries.slice(0, 1) : [];
    const rest = hasSummary ? entries.slice(1) : entries;
    const split = turnAwareSplit(rest.map((entry) => entry.message), keepRecent);
    const kept = stripOrphanToolMessagesWithAnchors([...summaryPrefix, ...rest.slice(split)]);
    session.history = kept.map((entry) => entry.message);
    session.historyAnchors = kept.map((entry) => entry.anchor);
  }

  async drainCompactions(): Promise<void> {
    await Promise.all([...this.compactionInFlight.values()].map((p) => p.catch(() => undefined)));
  }

  async recordTurn(chatId: string, turnTrace: Message[], origin: JsonlOrigin = 'chat'): Promise<Anchor[]> {
    this.assertNotShutdown('recordTurn');
    return this.enqueue(chatId, async () => {
      if (turnTrace.length === 0) {
        return [];
      }
      const anchors = await this.appendMessagesToJsonl(chatId, turnTrace, origin);
      const session = this.getOrCreateSessionState(chatId);
      session.history.push(...turnTrace);
      session.historyAnchors.push(...anchors);
      if (origin === 'chat') {
        this.chatsWithUserActivity.add(chatId);
        session.lastActiveAt = new Date();
      }
      this.sessions.set(chatId, session);
      // Persist the window snapshot so a restart resumes this tail from the day-file archive.
      this.saveWindowFor(chatId);
      return anchors;
    });
  }

  async addTurn(chatId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
    await this.recordTurn(chatId, [userMsg, assistantMsg]);
  }

  async recordPromptUsage(chatId: string, tokens?: number): Promise<void> {
    this.assertNotShutdown('recordPromptUsage');
    await this.enqueue(chatId, async () => {
      const reading = tokens !== undefined
        ? { tokens, estimated: false }
        : { tokens: estimateTokens(this.sessions.get(chatId)?.history ?? []) + FALLBACK_SYSTEM_OVERHEAD_TOKENS, estimated: true };
      this.lastPromptTokensByChat.set(chatId, reading);
      this.saveWindowFor(chatId);
    });
  }

  async resetSession(chatId: string): Promise<void> {
    await this.enqueue(chatId, async () => {
      const pendingSummary = this.pendingSummariesByChat.get(chatId);
      const tail = this.archiveTailFor(chatId);
      const replacement: SessionWindow = {
        summaryBlock: '',
        verbatimFrom: tail
          ? { file: tail.file, line: tail.line }
          : latestDayFileEof(this.archiveDir(chatId)),
        ...(pendingSummary ? { pendingSummary } : {}),
      };
      if (tail?.file) replacement.archiveTail = tail;
      saveWindow(this.windowPath(chatId), replacement);
      this.sessions.delete(chatId);
      this.chatsWithUserActivity.delete(chatId);
      this.lastPromptTokensByChat.delete(chatId);
      if (!pendingSummary) this.pendingSummariesByChat.delete(chatId);
    });
  }

  async runCompaction(chatId: string): Promise<void> {
    this.assertNotShutdown('runCompaction');
    await this.retryPendingSummaries();
    if (this.llmProvider) {
      await this.guardedCompaction(chatId);
    } else {
      await this.enqueue(chatId, async () => this.noLlmCompact(chatId));
    }
  }

  // The effective context window: an explicit config value wins over the per-model table.
  private effectiveContextWindow(): number {
    return this.contextWindow ?? contextWindowFor(this.llmProvider?.modelName);
  }

  windowFillPercent(chatId: string): number {
    const reading = this.lastPromptTokensByChat.get(chatId);
    if (!reading) return 0;
    const window = this.effectiveContextWindow();
    return window > 0 ? (reading.tokens / window) * 100 : 0;
  }

  private windowThresholds(): WindowConfig {
    const defaults = DEFAULT_SESSION_WINDOW;
    return {
      ...defaults,
      ...this.windowConfig,
      keepRecentTurns: this.windowConfig?.keepRecentTurns ?? this.compactionConfig?.keepRecentTurns ?? defaults.keepRecentTurns,
    };
  }

  private noLlmCompact(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    const keepRecent = Math.max(1, this.windowThresholds().keepRecentTurns);
    const first = session.history[0];
    const hasSummary = !!first && first.role === 'system'
      && typeof first.content === 'string' && first.content.startsWith(SUMMARY_PREFIX);
    const entries = session.history.map((message, index) => ({
      message,
      anchor: session.historyAnchors[index],
    }));
    const summaryPrefix = hasSummary ? entries.slice(0, 1) : [];
    const rest = hasSummary ? entries.slice(1) : entries;
    const split = turnAwareSplit(rest.map((entry) => entry.message), keepRecent);
    if (split === 0) return; // nothing older to drop
    const candidateEntries = stripOrphanToolMessagesWithAnchors([...summaryPrefix, ...rest.slice(split)]);
    const candidate = candidateEntries.map((entry) => entry.message);
    const candidateAnchors = candidateEntries.map((entry) => entry.anchor);
    if (!this.persistCandidateWindow(
      chatId,
      hasSummary ? (first.content as string).slice(SUMMARY_PREFIX.length) : '',
      candidate,
      candidateAnchors,
    )) {
      return; // window save failed: keep the old window
    }
    session.history = candidate;
    session.historyAnchors = candidateAnchors;
  }

  private async doCompaction(chatId: string): Promise<void> {
    const snap = await this.enqueue(chatId, async () => this.captureCompactionSnapshot(chatId));
    if (!snap) return; // nothing older to summarize (never re-summarizes a lone leading summary)
    const built = await this.buildCompactionSummary(chatId, snap);
    if (!built) return; // flush/summary failed or empty: keep the old window
    await this.enqueue(chatId, async () => this.applyCompaction(chatId, snap, built));
  }

  private captureCompactionSnapshot(chatId: string): CompactionSnapshot | null {
    const session = this.sessions.get(chatId);
    if (!session) return null;
    const keepRecent = Math.max(1, this.windowThresholds().keepRecentTurns);
    const history = session.history;
    const first = history[0];
    const hasSummary = !!first && first.role === 'system'
      && typeof first.content === 'string' && first.content.startsWith(SUMMARY_PREFIX);
    const oldSummary = hasSummary ? (first.content as string).slice(SUMMARY_PREFIX.length) : '';
    const split = turnAwareSplit(history, keepRecent);
    const olderReal = history.slice(hasSummary ? 1 : 0, split); // exclude the leading summary
    if (olderReal.length === 0) return null;
    const rangeAnchors = session.historyAnchors
      .slice(hasSummary ? 1 : 0, split)
      .filter((anchor): anchor is Anchor => anchor !== undefined);
    return {
      historyRef: history,
      historyAnchorsRef: session.historyAnchors,
      split,
      oldSummary,
      olderReal,
      rangeAnchors,
    };
  }

  private async buildCompactionSummary(chatId: string, snap: CompactionSnapshot): Promise<{ combinedSummary: string; newBullets: string } | null> {
    const doFlush = this.compactionConfig?.memoryFlush ?? true;
    if (doFlush && this.toolRegistry && this.llmProvider) {
      const flushPrompt = `Before this conversation is compacted, persist durable memory.
- Save health facts to memory files using memory_write if needed.
- Capture open follow-ups.
- If nothing is important, respond briefly.`;
      try {
        const memoryTools = this.toolRegistry.getAvailable('background').filter(t => t.group === 'group:memory');
        const toolSchemas: ToolSchema[] = memoryTools.map(t => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: { type: 'object' as const, properties: t.parameters.properties, required: t.parameters.required },
          },
        }));
        const flushResponse = await this.runLLMWithRetry<LLMResponse>('compaction-flush', () => this.llmProvider!.chat(
          [
            { role: 'system', content: flushPrompt },
            ...stripOrphanToolMessages(snap.olderReal),
            { role: 'user', content: 'Persist what should be remembered before compaction.' },
          ],
          toolSchemas,
        ));
        if (flushResponse.type === 'tool_call') {
          for (const c of flushResponse.toolCalls) await this.toolRegistry.execute(c.name, c.arguments, { origin: 'background' });
        }
      } catch (e) {
        // The flush is a pipeline step: its failure keeps the old window (do not summarize).
        console.warn(`[session:${chatId}] Compaction flush failed (keeping current window):`, summarizeErrorForLog(e));
        return null;
      }
    }

    const compactPrompt = `Summarize the conversation turns below.
Preserve:
- health facts
- user preferences
- open questions
- follow-up actions
- notable report-analysis outcomes
Keep it concise and structured.`;
    try {
      const summaryResponse = await this.runLLMWithRetry<LLMResponse>('compaction-summary', () => this.llmProvider!.chat([
        { role: 'system', content: compactPrompt },
        { role: 'user', content: JSON.stringify(snap.olderReal) },
      ]));
      const summaryText = summaryResponse.type === 'text' && summaryResponse.text.trim().length > 0
        ? summaryResponse.text.trim()
        : null;
      if (!summaryText) {
        console.warn(`[session:${chatId}] Compaction produced no summary; keeping the current window.`);
        return null;
      }
      // Strip any model-fabricated anchor, then attach app-supplied in-range anchors.
      const newBullets = anchorSummaryBullets(stripModelAnchors(summaryText), snap.rangeAnchors);
      // Preserve the prior summary verbatim (its facts and anchors), append the new bullets.
      const combinedSummary = snap.oldSummary ? `${snap.oldSummary}\n${newBullets}` : newBullets;
      return { combinedSummary, newBullets };
    } catch (e) {
      // Any step failing keeps the old window and retries on the next trigger. Sanitized frame only (PHI).
      console.warn(`[session:${chatId}] Compact turn failed (keeping current window):`, summarizeErrorForLog(e));
      return null;
    }
  }

  private async applyCompaction(chatId: string, snap: CompactionSnapshot, built: { combinedSummary: string; newBullets: string }): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session || session.history !== snap.historyRef || session.historyAnchors !== snap.historyAnchorsRef) {
      return; // live-tail changed ⇒ abort
    }
    const recentTail = session.history.slice(snap.split).map((message, index) => ({
      message,
      anchor: session.historyAnchors[snap.split + index],
    })); // includes turns recorded during the LLM call
    const candidateEntries = stripOrphanToolMessagesWithAnchors([
      { message: { role: 'system', content: `${SUMMARY_PREFIX}${built.combinedSummary}` }, anchor: undefined },
      ...recentTail,
    ]);
    const candidate = candidateEntries.map((entry) => entry.message);
    const candidateAnchors = candidateEntries.map((entry) => entry.anchor);
    if (!this.persistCandidateWindow(chatId, built.combinedSummary, candidate, candidateAnchors, built.newBullets)) {
      return; // window save failed: keep the old window
    }
    session.history = candidate;
    session.historyAnchors = candidateAnchors;
    this.pendingSummariesByChat.set(chatId, built.newBullets);
    if (this.summarySink) {
      await this.flushPendingSummaryLocked(chatId);
    }
  }

  private persistCandidateWindow(
    chatId: string,
    summaryBlock: string,
    history: Message[],
    historyAnchors: Array<Anchor | undefined>,
    pendingSummary?: string,
  ): boolean {
    const window = this.windowForHistory(chatId, history, historyAnchors, pendingSummary);
    try {
      saveWindow(this.windowPath(chatId), window);
      return true;
    } catch (e) {
      console.warn(`[session:${chatId}] window save failed; keeping the old window (compaction not applied):`, summarizeErrorForLog(e));
      return false;
    }
  }

  private async appendMessagesToJsonl(chatId: string, messages: Message[], origin: JsonlOrigin = 'chat'): Promise<Anchor[]> {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const lines = messages.map(msg => JSON.stringify(this.serializeEntry(chatId, msg, now, origin)));
    const dayFilePath = this.dayFilePath(chatId, nowDate);
    const block = (dayFileEndsWithoutNewline(dayFilePath) ? '\n' : '') + lines.join('\n') + '\n';
    const startLine = this.dayFileLineCount(dayFilePath);
    const dayFile = `${dateKey(nowDate)}.jsonl`;
    const anchors: Anchor[] = messages.map((_msg, i) => ({ file: dayFile, line: startLine + i + 1 }));
    secureAppend(dayFilePath, block);
    const endLine = startLine + lines.length;
    this.dayFileLineCounts.set(dayFilePath, endLine);
    try {
      this.archiveTailsByDir.set(this.archiveDir(chatId), {
        file: dayFile,
        line: endLine,
        byteLength: fs.statSync(dayFilePath).size,
      });
    } catch {
      this.archiveTailsByDir.delete(this.archiveDir(chatId));
    }
    if (this.turnIndex) {
      for (let i = 0; i < messages.length; i++) {
        const content = messages[i].content;
        if (typeof content !== 'string' || content.length === 0) continue;
        try {
          this.turnIndex.indexTurn(chatId, anchors[i].file, anchors[i].line, messages[i].role, now, content);
        } catch (e) {
          console.warn(`[session:${chatId}] turn indexing failed, continuing:`, summarizeErrorForLog(e));
          this.turnIndex.markDirty?.();
        }
      }
    }
    return anchors;
  }

  private dayFileLineCount(dayFilePath: string): number {
    let count = this.dayFileLineCounts.get(dayFilePath);
    if (count === undefined) {
      count = countDayFileLines(dayFilePath);
      this.dayFileLineCounts.set(dayFilePath, count);
    }
    return count;
  }

  private dayFilePath(chatId: string, now: Date): string {
    const day = `${dateKey(now)}.jsonl`;
    const resolved = this.perChatArchive
      ? resolveContainedPath(this.sessionsPath, chatId, day)
      : resolveContainedPath(this.sessionsPath, day);
    this.assertRegularFileIfPresent(resolved);
    return resolved;
  }

  private serializeEntry(chatId: string, msg: Message, timestamp: string, origin: JsonlOrigin = 'chat'): JsonlEntry {
    const entry: JsonlEntry = {
      timestamp,
      role: msg.role,
      content: msg.content ?? null,
      chatId,
    };
    entry.origin = origin;
    if (msg.role === 'tool' && msg.tool_call_id) {
      entry.tool_call_id = msg.tool_call_id;
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      entry.tool_calls = msg.tool_calls;
    }
    return entry;
  }

  private entryToMessage(entry: JsonlEntry): Message | null {
    if (!['system', 'user', 'assistant', 'tool'].includes(entry.role)) {
      return null;
    }

    const message: Message = {
      role: entry.role,
      content: entry.content ?? (entry.toolResult ?? ''),
    };

    const toolCalls = entry.tool_calls ?? entry.toolCalls;
    if (entry.role === 'assistant' && toolCalls && toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    if (entry.role === 'tool') {
      message.tool_call_id = entry.tool_call_id ?? entry.toolCallId ?? entry.toolName;
    }

    return message;
  }

  private windowPath(chatId: string): string {
    const resolved = this.perChatArchive
      ? resolveContainedPath(this.sessionsPath, `session-window.${chatId}.json`)
      : resolveContainedPath(this.sessionsPath, 'session-window.json');
    this.assertRegularFileIfPresent(resolved);
    return resolved;
  }

  // The day-file archive directory for `chatId`: flat per profile or namespaced per chat. Mirrors `dayFilePath`.
  private archiveDir(chatId: string): string {
    return this.perChatArchive ? resolveContainedPath(this.sessionsPath, chatId) : this.sessionsPath;
  }

  private assertRegularFileIfPresent(filePath: string): void {
    try {
      if (!fs.lstatSync(filePath).isFile()) throw new PathContainmentError('unavailable');
    } catch (error) {
      if (error instanceof PathContainmentError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  /** Build a window cursor from the physical anchor of its first retained archive message. */
  private windowForHistory(
    chatId: string,
    history: Message[],
    historyAnchors: Array<Anchor | undefined>,
    pendingSummary?: string,
  ): SessionWindow {
    const first = history[0];
    const hasSummary =
      !!first && first.role === 'system' && typeof first.content === 'string' && first.content.startsWith(SUMMARY_PREFIX);
    const firstRealIndex = hasSummary ? 1 : 0;
    const summaryBlock = hasSummary ? (first.content as string).slice(SUMMARY_PREFIX.length) : '';
    const realTailLength = history.length - firstRealIndex;
    const firstAnchor = historyAnchors[firstRealIndex];
    let verbatimFrom: Anchor;
    if (realTailLength > 0 && firstAnchor) {
      verbatimFrom = anchorBefore(firstAnchor);
    } else {
      const resolution = deriveWindowAnchor(this.archiveDir(chatId), realTailLength, this.archiveTailFor(chatId));
      verbatimFrom = resolution.anchor;
      if (resolution.source === 'fallback') {
        console.warn(`[session:${chatId}] archive tail watermark unavailable; using bounded recovery walk`);
      }
    }
    const window: SessionWindow = { summaryBlock, verbatimFrom };
    const tail = this.archiveTailFor(chatId);
    if (tail?.file) window.archiveTail = tail;
    if (pendingSummary) window.pendingSummary = pendingSummary;
    // Carry the last window-fill reading so a restart resumes the trigger signal.
    const usage = this.lastPromptTokensByChat.get(chatId);
    if (usage) {
      window.lastPromptTokens = usage.tokens;
      window.lastPromptTokensEstimated = usage.estimated;
    }
    return window;
  }

  private deriveWindow(chatId: string): SessionWindow {
    const session = this.sessions.get(chatId);
    return this.windowForHistory(
      chatId,
      session?.history ?? [],
      session?.historyAnchors ?? [],
      this.pendingSummariesByChat.get(chatId),
    );
  }

  /** Resolve the current archive EOF without rereading older day files. */
  private archiveTailFor(chatId: string): ArchiveTail | undefined {
    const archiveDir = this.archiveDir(chatId);
    const cached = this.archiveTailsByDir.get(archiveDir);
    if (cached && isArchiveTailCurrent(archiveDir, cached)) {
      return cached;
    }
    const current = latestDayFileTail(archiveDir);
    if (current.file === '') return undefined;
    this.archiveTailsByDir.set(archiveDir, current);
    return current;
  }

  private restoreArchiveTail(chatId: string, archiveDir: string, persisted?: ArchiveTail): void {
    const current = latestDayFileTail(archiveDir);
    if (current.file === '') {
      this.archiveTailsByDir.delete(archiveDir);
      return;
    }
    if (persisted
      && persisted.file === current.file
      && persisted.line === current.line
      && persisted.byteLength === current.byteLength) {
      this.archiveTailsByDir.set(archiveDir, persisted);
      return;
    }
    this.archiveTailsByDir.set(archiveDir, current);
    if (persisted) {
      console.warn(`[session:${chatId}] archive tail watermark stale; using recovery metadata`);
    }
  }

  private saveWindowFor(chatId: string): boolean {
    try {
      saveWindow(this.windowPath(chatId), this.deriveWindow(chatId));
      return true;
    } catch (e) {
      console.warn(`[session:${chatId}] window state save failed, continuing:`, summarizeErrorForLog(e));
      return false;
    }
  }

  private resumeSessions(): void {
    if (!fs.existsSync(this.sessionsPath)) return;

    if (this.perChatArchive) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(this.sessionsPath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        try {
          if (listDayFiles(this.archiveDir(e.name)).length > 0) {
            this.resumeChat(e.name);
          }
        } catch (error) {
          console.warn('[session] skipping unsafe chat archive lane during resume:', summarizeErrorForLog(error));
        }
      }
    } else {
      const chatIds = new Set<string>();
      for (const l of readLinesAfter(this.sessionsPath, { file: '', line: 0 })) {
        const cid = this.chatIdOfRaw(l.raw);
        if (cid) chatIds.add(cid);
      }
      for (const chatId of chatIds) this.resumeChat(chatId);
    }

    if (this.sessions.size > 0) {
      console.log(`[session] Resumed ${this.sessions.size} session(s) from the window + day-file archive`);
    }
  }

  private resumeChat(chatId: string): void {
    const window = resolveWindow(this.windowPath(chatId), this.archiveDir(chatId));
    this.restoreArchiveTail(chatId, this.archiveDir(chatId), window.archiveTail);
    if (window.lastPromptTokens !== undefined) {
      this.lastPromptTokensByChat.set(chatId, {
        tokens: window.lastPromptTokens,
        estimated: window.lastPromptTokensEstimated ?? false,
      });
    }
    if (window.pendingSummary) this.pendingSummariesByChat.set(chatId, window.pendingSummary);
    else this.pendingSummariesByChat.delete(chatId);
    const tail: AnchoredMessage[] = [];
    let lastTimestamp: Date | undefined;
    let hasUserActivity = false;
    for (const line of readLinesAfter(this.archiveDir(chatId), window.verbatimFrom)) {
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(line.raw) as JsonlEntry;
      } catch {
        continue; // malformed physical slot — skip when reconstructing
      }
      if (entry.chatId !== chatId) continue; // registry mode: only this chat's entries
      const message = this.entryToMessage(entry);
      if (!message) continue;
      tail.push({ message, anchor: { file: line.file, line: line.line } });
      const ts = new Date(entry.timestamp);
      if ((entry.origin ?? 'chat') === 'chat') {
        hasUserActivity = true;
        if (!Number.isNaN(ts.getTime())) lastTimestamp = ts;
      }
    }

    const rendered: AnchoredMessage[] = [
      ...(window.summaryBlock
        ? [{ message: { role: 'system' as const, content: SUMMARY_PREFIX + window.summaryBlock }, anchor: undefined }]
        : []),
      ...tail,
    ];
    const historyEntries = stripOrphanToolMessagesWithAnchors(rendered);
    if (historyEntries.length === 0) return;

    this.sessions.set(chatId, {
      chatId,
      history: historyEntries.map((entry) => entry.message),
      historyAnchors: historyEntries.map((entry) => entry.anchor),
      lastActiveAt: lastTimestamp ?? new Date(),
    });
    if (hasUserActivity) this.chatsWithUserActivity.add(chatId);
  }

  private chatIdOfRaw(raw: string): string | undefined {
    try {
      return (JSON.parse(raw) as JsonlEntry).chatId;
    } catch {
      return undefined;
    }
  }

  private enqueue<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const queue = this.operationQueues.get(chatId) ?? [];
      queue.push(async () => {
        try {
          resolve(await operation());
        } catch (e) {
          reject(e);
        }
      });
      this.operationQueues.set(chatId, queue);
      if (queue.length === 1) {
        void this.drainQueue(chatId);
      }
    });
  }

  private async drainQueue(chatId: string): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const queue = this.operationQueues.get(chatId);
      if (!queue || queue.length === 0) {
        this.operationQueues.delete(chatId);
        return;
      }
      const job = queue[0];
      try {
        await job();
      } catch {
        // error propagated via reject in caller
      }
      queue.shift();
    }
  }
}
