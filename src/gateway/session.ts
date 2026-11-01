import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message, ToolSchema } from '../providers/types';
import type { LLMProvider, LLMResponse } from '../providers/types';
import type { ToolRegistry } from '../tools/registry';
import { type RotationConfig } from '../scheduler/rotation';
import { DaemonShutdownError } from '../shared/errors';
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

// The system-message prefix that marks a compaction summary in the in-context history. Held as one
// constant so compaction (write), the window snapshot (derive), and resume (render) agree byte-for-byte.
const SUMMARY_PREFIX = '[Previous conversation summary]\n';

// Upper bound on a single day file the nightly sweep will read synchronously (64 MiB, far above any
// real day of chat). A larger file is skipped, not read.
const MAX_DAY_FILE_READ_BYTES = 64 * 1024 * 1024;

interface Session {
  chatId: string;
  history: Message[];
  /** One physical archive cursor per history message; summary messages carry no cursor. */
  historyAnchors: Array<Anchor | undefined>;
  lastActiveAt: Date;
}

// Provenance for the nightly sweep: 'chat' = a real user/agent turn (the default when the field is absent);
// 'heartbeat'/'system' = daemon-authored, never mined for capture misses.
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
  triggerAtTokenPercent: number;
  memoryFlush: boolean;
  keepRecentTurns: number;
}

// Window triggers. Structural twin of config's SessionWindowConfig, kept local so session.ts stays decoupled
// from the config module.
interface WindowConfig {
  pruneAtPercent: number;
  compactAtPercent: number;
  emergencyAtPercent: number;
  keepRecentTurns: number;
}

// A snapshot of what a compaction will summarize, captured under the write queue so the LLM can then run off the
// queue. `historyRef` is the history array at snapshot time; the apply aborts if it was replaced since.
// `olderReal` excludes any leading summary.
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
  softResetMinutes?: number;
  hardResetMinutes?: number;
  provider?: LLMProvider;
  toolRegistry?: ToolRegistry;
  compaction?: CompactionConfig;
  /** Real-token window triggers (defaults 35/50/80/10 when absent). */
  window?: WindowConfig;
  /** The model's context window in tokens; falls back to `contextWindowFor` when unset. */
  contextWindow?: number;
  profileId?: string;
  rotationConfig?: Partial<RotationConfig>;
  /**
   * Day-file archive layout. `false` (one thread per profile): `<sessionsPath>/YYYY-MM-DD.jsonl`.
   * `true` (per-chat isolation): `<sessionsPath>/<chatId>/YYYY-MM-DD.jsonl`.
   */
  perChatArchive?: boolean;
}

/**
 * The minimal seam by which the SessionManager feeds each appended archive line to the `session_search` FTS
 * index. Structural, so session.ts (gateway-tier) does not depend on the index implementation. Best-effort:
 * the caller wraps every call so an index failure degrades and never blocks a turn.
 */
export interface SessionTurnIndexer {
  indexTurn(chatId: string, file: string, line: number, role: string, ts: string, content: string): void;
  /** Durably flag a swallowed incremental-index failure so the next boot reconciles the hole. */
  markDirty?(): void;
  /** Rebuild derived rows after records are appended at new physical anchors. */
  reconcileFromDayFiles?(): void;
}

// Retry only transient upstream conditions. OpenAI SDK errors carry a numeric `status`; plain network failures
// (fetch TypeError) carry none.
function isTransientLlmError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true; // no status ⇒ network-ish ⇒ transient
  return status === 429 || status >= 500;
}

// A cheap safety-margin estimate, not exact accounting: a chars/4 English heuristic (20-30% error is fine
// because compaction runs well before the real context limit). No tokenizer, no new dependency.
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

// The chars/4 fallback (used only when a provider omits usage) counts history but not the system prompt and
// tool schemas the provider received, which can be several thousand tokens. This overhead makes the fallback
// err toward compacting. Real usage readings never use it.
const FALLBACK_SYSTEM_OVERHEAD_TOKENS = 3000;

export type WindowTrigger = 'none' | 'prune' | 'compact' | 'emergency';

export type WindowDerivationStatus = 'watermark' | 'fallback';

/**
 * Maps the window-fill percentage to a compaction action. Bounds are inclusive lower edges: below `prune`
 * none; `[prune,compact)` prune; `[compact,emergency)` compact; `>=emergency` emergency.
 */
export function windowTriggerFor(
  fillPercent: number,
  thresholds: { pruneAtPercent: number; compactAtPercent: number; emergencyAtPercent: number },
): WindowTrigger {
  if (fillPercent >= thresholds.emergencyAtPercent) return 'emergency';
  if (fillPercent >= thresholds.compactAtPercent) return 'compact';
  if (fillPercent >= thresholds.pruneAtPercent) return 'prune';
  return 'none';
}

// Conservative per-model context window. A miss returns 8192 (safe: triggers
// compaction earlier rather than overflowing a small window).
export function contextWindowFor(model?: string): number {
  if (!model) return 8192;
  const m = model.toLowerCase();
  if (/^gpt-5/.test(m) || /^o[1-9]/.test(m)) return 128000;
  if (m.includes('gpt-4o') || m.includes('gpt-4.1')) return 128000;
  if (m.includes('llama3.2')) return 128000;
  if (m.includes('kimi')) return 262144; // 256K context (shipped default main model)
  return 8192; // medgemma / unknown
}

// Tool-call group integrity: OpenAI rejects any history where a `tool` message does not answer a preceding
// `assistant`+`tool_calls`, or where an `assistant`+`tool_calls` is not immediately followed by its tool
// result(s). Compaction splits on a turn (user-message) boundary, never mid-group, and
// `stripOrphanToolMessages` sanitizes any history that still breaks the rule.

// Turn-aware retention split. A "turn" is the span from a `user` message to the next one. The kept (recent)
// slice starts on a user message, so it never begins with an orphaned tool group or half a turn. Returns the
// index where the recent slice begins; the older slice is history[0..split). Returns 0 (keep everything) when
// there are fewer turns than `keepTurns`.
export function turnAwareSplit(history: Message[], keepTurns: number): number {
  if (keepTurns <= 0) return history.length;
  const userIdx: number[] = [];
  for (let i = 0; i < history.length; i++) if (history[i].role === 'user') userIdx.push(i);
  if (userIdx.length <= keepTurns) return 0; // fewer complete turns than we keep ⇒ keep all
  return userIdx[userIdx.length - keepTurns]; // the user message that starts the last `keepTurns` turns
}

// Strip any `sessions/<file>#L<n>` anchor a model summary may contain, so every stored anchor is
// application-supplied and range-validated. Also removes an optional wrapping "( … )" and trailing whitespace.
function stripModelAnchors(text: string): string {
  return text.replace(/\s*\(?sessions\/\S+#L\d+\)?/g, '');
}

// Defensive sanitizer for compacted history and any other provider replay. Drops leading/orphan `tool` messages
// (no matching assistant+tool_calls parent) and a trailing `assistant`+`tool_calls` with no tool result.
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

// Marker that replaces pruned tool results in the window. The day-file archive keeps the verbatim result,
// retrievable via session_search.
export const PRUNED_TOOL_MARKER = '[tool result pruned — session_search to retrieve]';

// Prune keeps the last 5 turns verbatim (a "turn" runs from one `user` message to the next). This differs from
// compaction's keepRecentTurns.
const PRUNE_LAST_TURNS = 5;

/**
 * Swaps the content of `tool`-role messages older than the last `keepTurns` turns for the pruned marker. The
 * message, role and `tool_call_id` stay, so tool-group ordering holds. The archive line on disk is untouched.
 * A history with `<= keepTurns` turns is returned unchanged.
 */
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

/**
 * Gives every summary bullet a resolving `sessions/<file>#L<n>` anchor so nothing the summary references is
 * unreachable. Anchors come from `rangeAnchors` (the archive lines of the summarized turns), spread across the
 * bullets. A line that already carries an anchor is left as-is; blank lines are skipped.
 */
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

// True when the day file exists and its last byte is not '\n' (a torn or external write). Reads only the final
// byte. Any error is treated as a normal append.
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
  private softResetMs: number;
  private hardResetMs: number;
  private sessionsPath: string;
  private operationQueues: Map<string, Array<() => Promise<void>>> = new Map();
  private readonly chatsWithUserActivity: Set<string> = new Set();
  private readonly llmProvider?: LLMProvider;
  private readonly toolRegistry?: ToolRegistry;
  private readonly compactionConfig?: CompactionConfig;
  private readonly windowConfig?: WindowConfig;
  private readonly contextWindow?: number;
  private readonly profileId: string;
  // The last window-fill reading per chat: real `usage.promptTokens` (estimated:false) or a chars/4 fallback
  // (estimated:true). Persisted in the window state. `triggered` marks a reading already consumed by a
  // prune/compact/emergency this cycle, so the same stale reading cannot re-fire; the next recordPromptUsage
  // clears it.
  private readonly lastPromptTokensByChat: Map<string, { tokens: number; estimated: boolean; triggered?: boolean }> = new Map();
  // The in-flight background compaction per chat, so a second trigger never starts a second pipeline.
  private readonly compactionInFlight: Map<string, Promise<void>> = new Map();
  private readonly rotationConfig?: Partial<RotationConfig>;
  private readonly perChatArchive: boolean;
  // The current physical non-empty line count of each day file, keyed by full path. Seeded from disk on first
  // touch (in-memory tracking is lost on restart and `secureAppend` does not fsync), then advanced on append,
  // so a fresh manager continues the numbering.
  private readonly dayFileLineCounts: Map<string, number> = new Map();
  // Durable EOF watermarks live in SessionWindow; this process-local map avoids rereading even the current day
  // file between window saves. The key is the resolved archive lane.
  private readonly archiveTailsByDir: Map<string, ArchiveTail> = new Map();
  private readonly windowDerivationStatusByChat: Map<string, WindowDerivationStatus> = new Map();
  // Compaction LLM calls run at 'background' semaphore priority so they never starve user turns. Injected by the
  // Gateway; when unset (tests), the call runs directly. prepareHistory runs before the AgentLoop acquires the
  // semaphore, so this acquire cannot self-deadlock.
  private runBackground?: <T>(fn: () => Promise<T>) => Promise<T>;
  // The session_search FTS index. When wired, recordTurn feeds each appended archive line to it (best-effort).
  // Without it there is no incremental indexing.
  private turnIndex?: SessionTurnIndexer;
  // A summary copy is durable pending work until the sink and the cleared window state both commit.
  private readonly pendingSummariesByChat: Map<string, string> = new Map();
  // Lifecycle hard gate: true once the owning runtime has closed its SQLite handles (never merely "stopping").
  // A late recordTurn would touch a closed index handle, so it refuses instead. Keyed on "closed" so a turn that
  // started before stop() can still drain. Wired by the composition root; unset means never shut down.
  private isShutdown: () => boolean = () => false;

  /** Wire compaction LLM calls through the semaphore at background priority. */
  setBackgroundRunner(run: <T>(fn: () => Promise<T>) => Promise<T>): void {
    this.runBackground = run;
  }

  /**
   * Wire the shutdown hard gate: recordTurn, recordPromptUsage and runCompaction refuse with a
   * DaemonShutdownError once the owning ProfileRuntime has closed its stores.
   */
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

  // The sink that copies each compaction summary (anchored bullets) to the chat-scoped session-summary lane.
  // Wired by the Gateway through the WriteQueue. Best-effort: a sink failure never fails compaction.
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

    // The sink succeeded, but the marker is cleared only after the window state is durably updated.
    // If that second write fails, restore the in-memory marker so the copy is retried at least once.
    this.pendingSummariesByChat.delete(chatId);
    if (!this.saveWindowFor(chatId)) this.pendingSummariesByChat.set(chatId, summary);
  }

  /** The resolved day-file archive root — the Gateway builds the search index over this same directory. */
  get sessionsDir(): string {
    return this.sessionsPath;
  }

  /**
   * Every chat's raw JSONL day-file lines for the UTC day of `date`, for the nightly sweep. Read-only and
   * best-effort: a missing or unreadable file contributes nothing, blank lines are dropped, and it never throws.
   */
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
      // readdir order is filesystem-defined; sort so the sweep's cross-chat ordering and selection are deterministic.
      // `isDirectory()` reflects lstat, so a symlinked chat dir is already excluded.
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
      // Reject a symlinked (or otherwise non-regular) day file: following it could read another profile's transcript
      // (cross-profile PHI) or block on a FIFO. Cap the read so one huge file cannot exhaust the heap.
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

  // Compaction LLM calls are the largest requests a session makes, so on shared-pool providers they hit transient
  // upstream rate limits most often. Bounded retry with linear backoff before degrading.
  private compactionRetry = { attempts: 3, backoffMs: 1500 };

  /** Test/ops hook: tune compaction LLM retry behavior. */
  setCompactionRetryPolicy(policy: { attempts?: number; backoffMs?: number }): void {
    this.compactionRetry = {
      attempts: policy.attempts ?? this.compactionRetry.attempts,
      backoffMs: policy.backoffMs ?? this.compactionRetry.backoffMs,
    };
  }

  private async runLLMWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const { attempts, backoffMs } = this.compactionRetry;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.runLLM(fn);
      } catch (e) {
        lastError = e;
        // Deterministic failures (4xx: bad request, auth) will never succeed on
        // retry — only transient upstream conditions are worth another attempt.
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
    softResetMinutes: number,
    hardResetMinutes: number,
    sessionsPath?: string,
    llmProvider?: LLMProvider,
    toolRegistry?: ToolRegistry,
    compactionConfig?: CompactionConfig,
    profileId?: string,
    rotationConfig?: Partial<RotationConfig>,
  );
  constructor(
    a?: SessionManagerOptions | number,
    hardResetMinutes?: number,
    sessionsPath?: string,
    llmProvider?: LLMProvider,
    toolRegistry?: ToolRegistry,
    compactionConfig?: CompactionConfig,
    profileId?: string,
    rotationConfig?: Partial<RotationConfig>,
  ) {
    // Accepts either an options object or positional args.
    const opts: SessionManagerOptions =
      typeof a === 'object' && a !== null
        ? a
        : {
            softResetMinutes: a,
            hardResetMinutes,
            sessionsPath,
            provider: llmProvider,
            toolRegistry,
            compaction: compactionConfig,
            profileId,
            rotationConfig,
          };
    this.softResetMs = (opts.softResetMinutes ?? 240) * 60 * 1000;
    this.hardResetMs = (opts.hardResetMinutes ?? 1440) * 60 * 1000;
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

  /** Whether the last derived window used its EOF watermark or the recovery walk. */
  getWindowDerivationStatus(chatId: string): WindowDerivationStatus | undefined {
    return this.windowDerivationStatusByChat.get(chatId);
  }

  async prepareHistory(chatId: string): Promise<Message[]> {
    // Three phases so the compaction LLM runs off the per-chat write queue: a fast queued evaluate+prune, then (for
    // compact/emergency) the pipeline whose LLM is off-queue and whose apply re-enters the queue, then a fast queued
    // read of the resulting window.
    const trigger = await this.enqueue(chatId, async () => {
      const session = this.sessions.get(chatId);
      if (!session) return 'none' as WindowTrigger;
      // The perpetual thread never idle-resets. Real-token triggers map the last window-fill reading to
      // prune / compact / emergency.
      const t = this.evaluateWindowTrigger(chatId);
      if (t !== 'none') {
        // Consume the reading so the same stale value cannot re-fire the trigger every turn (it changes only on the next
        // recordPromptUsage).
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
      // Compact: LLM pipeline in the background (off-queue LLM, queued live-tail apply). Return the current
      // (possibly over-budget) window now; the compacted one lands on a later turn.
      this.startBackgroundCompaction(chatId);
    } else if (trigger === 'emergency') {
      // Emergency: reduce before the turn proceeds (awaited). Always runs, even with compaction disabled.
      await this.runEmergencyCompaction(chatId);
    }

    // The returned history is the window: the summary system message (if any) followed by the verbatim tail,
    // sanitized so this boundary never emits a history OpenAI would reject.
    return this.enqueue(chatId, async () =>
      stripOrphanToolMessages([...(this.sessions.get(chatId)?.history ?? [])]),
    );
  }

  // Maps the current window-fill reading to a trigger. A reading already consumed this cycle (`triggered`) yields
  // 'none' so the same stale value never re-fires.
  private evaluateWindowTrigger(chatId: string): WindowTrigger {
    const reading = this.lastPromptTokensByChat.get(chatId);
    if (!reading || reading.triggered) return 'none';
    return windowTriggerFor(this.windowFillPercent(chatId), this.windowThresholds());
  }

  // Run at most one compaction pipeline per chat at a time. A concurrent trigger (a second compact, or an emergency
  // arriving during a compact) reuses the same in-flight promise. The LLM runs off the write queue; only the
  // snapshot and apply re-enter it. Never rejects (best-effort).
  private guardedCompaction(chatId: string): Promise<void> {
    const existing = this.compactionInFlight.get(chatId);
    if (existing) return existing;
    const p = this.doCompaction(chatId)
      .catch((e) => console.warn(`[session:${chatId}] compaction failed:`, summarizeErrorForLog(e)))
      .finally(() => this.compactionInFlight.delete(chatId));
    this.compactionInFlight.set(chatId, p);
    return p;
  }

  // Background compaction (fire-and-forget). Honors compaction.enabled=false: no proactive compaction when
  // disabled, but the emergency valve still protects against overflow.
  private startBackgroundCompaction(chatId: string): void {
    if (this.compactionConfig?.enabled === false) return;
    void this.guardedCompaction(chatId);
  }

  // Emergency (awaited before the turn). When enabled and an LLM is available, summarize (reusing an in-flight
  // pipeline). Then guarantee the window is within budget with a no-LLM turn-aware truncate that preserves a
  // leading summary. Idempotent; a no-op when a just-applied compaction already reached the target.
  private async runEmergencyCompaction(chatId: string): Promise<void> {
    if (this.compactionConfig?.enabled !== false && this.llmProvider) {
      await this.guardedCompaction(chatId);
    }
    await this.enqueue(chatId, async () => {
      this.emergencyTruncate(chatId);
      this.saveWindowFor(chatId);
    });
  }

  // Overflow valve: reduce the in-memory window to a leading summary (kept as metadata) plus the last
  // `keepRecentTurns` turns. No LLM. Swaps in memory regardless of window-save success (the caller persists
  // best-effort) so an emergency can never leave the window over budget.
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

  // Drain any in-flight compaction for a chat (used by tests + graceful shutdown). Never rejects.
  async awaitCompaction(chatId: string): Promise<void> {
    await this.compactionInFlight.get(chatId)?.catch(() => undefined);
  }

  // Await every in-flight background compaction (graceful shutdown): a fire-and-forget pipeline must not write the
  // window or summary sink after the store closes. Never rejects.
  async drainCompactions(): Promise<void> {
    await Promise.all([...this.compactionInFlight.values()].map((p) => p.catch(() => undefined)));
  }

  async recordTurn(chatId: string, turnTrace: Message[], origin: JsonlOrigin = 'chat'): Promise<Anchor[]> {
    this.assertNotShutdown('recordTurn');
    return this.enqueue(chatId, async () => {
      if (turnTrace.length === 0) {
        return [];
      }
      // Persist first: append to the JSONL before mutating in-memory state. If the append or rotation throws, the
      // enqueue promise rejects and in-memory history never sees the turn, so memory and disk cannot diverge. `origin`
      // is stamped so the nightly sweep can trust provenance (heartbeat turns are daemon-authored).
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

  /**
   * The current EOF anchor of `chatId`'s day file for `now`: `{file: <day-file basename>, line: <physical
   * non-empty line count>}`. The count is re-derived from disk on first touch. Used by `/new` and compaction.
   */
  currentDayFileAnchor(chatId: string, now: Date = new Date()): Anchor {
    return { file: `${dateKey(now)}.jsonl`, line: this.dayFileLineCount(this.dayFilePath(chatId, now)) };
  }

  async addTurn(chatId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
    await this.recordTurn(chatId, [userMsg, assistantMsg]);
  }

  /**
   * Record the window-fill signal after a completed turn. `tokens` is the last provider call's
   * `usage.promptTokens`; `undefined` means a flagged chars/4 estimate over the current window. Routed through
   * the op queue so it serializes with recordTurn / prepareHistory / compaction.
   */
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

  /**
   * `/new`: publish an empty EOF window before clearing in-memory state. The append-only day-file archive is
   * untouched, so the disk log continues with contiguous line numbers and stays searchable via session_search.
   * A failed replacement write rejects the reset and leaves the old state in place; callers must not report a
   * successful reset after that failure.
   */
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
      // Persist the replacement first. The old window remains authoritative until this atomic write
      // succeeds, so a crash or unlink failure cannot resurrect pre-/new context.
      saveWindow(this.windowPath(chatId), replacement);
      this.sessions.delete(chatId);
      this.chatsWithUserActivity.delete(chatId);
      this.lastPromptTokensByChat.delete(chatId);
      if (!pendingSummary) this.pendingSummariesByChat.delete(chatId);
    });
  }

  // Public compaction (the /compact command). With an LLM: the full pipeline (off-queue LLM, queued live-tail
  // apply), reusing an in-flight one. Without an LLM: a synchronous turn-aware truncate.
  async runCompaction(chatId: string): Promise<void> {
    this.assertNotShutdown('runCompaction');
    await this.retryPendingSummaries();
    if (this.llmProvider) {
      await this.guardedCompaction(chatId);
    } else {
      await this.enqueue(chatId, async () => this.noLlmCompact(chatId));
    }
  }

  /**
   * Prune: replace in-window tool results older than the last 5 turns with the marker (lossless; the day file is
   * untouched and session_search returns the verbatim original). No LLM; runs synchronously inside the op queue.
   * The window pointer is unchanged, so a restart replays the verbatim tail and prune re-fires as the window fills.
   */
  async pruneWindow(chatId: string): Promise<void> {
    await this.enqueue(chatId, async () => {
      const session = this.sessions.get(chatId);
      if (!session) return;
      session.history = pruneToolResults(session.history, PRUNE_LAST_TURNS);
      this.saveWindowFor(chatId);
    });
  }

  // The effective context window: an explicit config value wins over the per-model table.
  private effectiveContextWindow(): number {
    return this.contextWindow ?? contextWindowFor(this.llmProvider?.modelName);
  }

  /**
   * The current window-fill percentage for `chatId`: the last recorded token reading (real `usage.promptTokens`
   * or a flagged chars/4 estimate) over the effective context window. 0 when no usage has been recorded.
   */
  windowFillPercent(chatId: string): number {
    const reading = this.lastPromptTokensByChat.get(chatId);
    if (!reading) return 0;
    const window = this.effectiveContextWindow();
    return window > 0 ? (reading.tokens / window) * 100 : 0;
  }

  // The window thresholds and keepRecentTurns in effect (config, else the defaults 35/50/80/10).
  private windowThresholds(): WindowConfig {
    return {
      pruneAtPercent: this.windowConfig?.pruneAtPercent ?? 35,
      compactAtPercent: this.windowConfig?.compactAtPercent ?? 50,
      emergencyAtPercent: this.windowConfig?.emergencyAtPercent ?? 80,
      keepRecentTurns: this.windowConfig?.keepRecentTurns ?? this.compactionConfig?.keepRecentTurns ?? 10,
    };
  }

  // No-LLM compaction (no provider): a synchronous turn-aware truncate that preserves a leading summary.
  // Candidate-then-swap, so a failed window save keeps the old window. Runs inside a queued op.
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

  // The pipeline in three parts so the LLM runs off the write queue:
  //   1. snapshot (queued read) → 2. flush + summary LLM (off-queue) → 3. apply (queued, live-tail).
  private async doCompaction(chatId: string): Promise<void> {
    const snap = await this.enqueue(chatId, async () => this.captureCompactionSnapshot(chatId));
    if (!snap) return; // nothing older to summarize (never re-summarizes a lone leading summary)
    const built = await this.buildCompactionSummary(chatId, snap);
    if (!built) return; // flush/summary failed or empty: keep the old window
    await this.enqueue(chatId, async () => this.applyCompaction(chatId, snap, built));
  }

  // Snapshot: the real older messages to summarize (excluding any leading summary), the preserved prior-summary
  // text, and the archive anchors for the older range. null means nothing to do.
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

  // Flush + summary, run off the write queue. A flush failure is a failed step: return null (keep the old window),
  // never fall through to a summary. The prior summary is preserved verbatim and the new bullets are appended.
  // Model-supplied anchors are stripped before app-supplied ones are added.
  private async buildCompactionSummary(chatId: string, snap: CompactionSnapshot): Promise<{ combinedSummary: string; newBullets: string } | null> {
    const doFlush = this.compactionConfig?.memoryFlush ?? true;
    if (doFlush && this.toolRegistry && this.llmProvider) {
      const flushPrompt = `Before this conversation is compacted, persist durable memory.
- Save health facts to memory files using memory_write if needed.
- Capture open follow-ups.
- If nothing is important, respond briefly.`;
      try {
        const memoryTools = this.toolRegistry.getAvailable().filter(t => t.group === 'group:memory');
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
          for (const c of flushResponse.toolCalls) await this.toolRegistry.execute(c.name, c.arguments);
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

  // Apply against the live tail: if the history array was replaced since the snapshot (emergency truncate, prune
  // or reset), abort, because the reduction already happened another way. Persist the candidate window first; swap
  // in memory only on success. Then copy the new bullets to the daily log (best-effort, idempotent; never the
  // preserved old summary, so nothing is logged twice).
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

  // Persist a candidate window (summary + a verbatim tail) without mutating in-memory state. The candidate carries
  // physical anchors for every retained message, so malformed archive slots do not shift its cursor. Returns true
  // on a successful save, false (keep the old window) on failure.
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
    // secureAppend has no fsync, so a power loss or external truncation can leave the day file without a trailing
    // newline. A raw append would fuse the new record onto the torn line and lose that (health) turn on resume and
    // rebuild. Insert a separating newline so the new record always starts its own physical line.
    const block = (dayFileEndsWithoutNewline(dayFilePath) ? '\n' : '') + lines.join('\n') + '\n';
    // Assign each appended message a stable {file, line} anchor from the re-derived count. The first appended
    // message takes line `count+1`; the file basename is the anchor's `file`.
    const startLine = this.dayFileLineCount(dayFilePath);
    const dayFile = `${dateKey(nowDate)}.jsonl`;
    const anchors: Anchor[] = messages.map((_msg, i) => ({ file: dayFile, line: startLine + i + 1 }));
    // The append-only day-file archive is the sole store, and day files are never size-rotated (anchors must stay
    // stable). Persist-first holds: a failed append rejects the enqueue and `recordTurn` never mutates in-memory state.
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
      // The source append succeeded. If the metadata stat is unavailable, discard the cached
      // watermark and let the next window derivation recover from the newest day file.
      this.archiveTailsByDir.delete(this.archiveDir(chatId));
    }
    // Incrementally index each appended line for session_search (best-effort: an index failure degrades and never
    // blocks the turn). The `{file, line}` anchor is the day-file's physical line, so an incrementally-indexed row
    // and a disk rebuild resolve to the same JSONL line (idempotent upsert). Skip null/empty-content messages (e.g.
    // an assistant tool-call carrier): nothing textual to search.
    if (this.turnIndex) {
      for (let i = 0; i < messages.length; i++) {
        const content = messages[i].content;
        if (typeof content !== 'string' || content.length === 0) continue;
        try {
          this.turnIndex.indexTurn(chatId, anchors[i].file, anchors[i].line, messages[i].role, now, content);
        } catch (e) {
          // Per-line guard: one line's index failure must not skip its siblings. Mark the index dirty so the next boot
          // reconciles the hole from the archive.
          console.warn(`[session:${chatId}] turn indexing failed, continuing:`, summarizeErrorForLog(e));
          this.turnIndex.markDirty?.();
        }
      }
    }
    return anchors;
  }

  // The day file's current physical non-empty line count, seeded from disk on first touch (never trusted across a
  // restart, since there is no fsync), then advanced in memory on append.
  private dayFileLineCount(dayFilePath: string): number {
    let count = this.dayFileLineCounts.get(dayFilePath);
    if (count === undefined) {
      count = countDayFileLines(dayFilePath);
      this.dayFileLineCounts.set(dayFilePath, count);
    }
    return count;
  }

  // The append-only archive path for `chatId` on the day of `now`: flat per profile or namespaced per chat,
  // depending on the archive layout. Day boundaries use the shared UTC `dateKey`, so a turn after local midnight
  // lands in the correct file.
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
    // Every current entry carries explicit provenance. Read-back stays tolerant of origin-less lines, but the marker
    // heuristic applies only to those.
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

  // The per-chat window state file. One per profile in flat mode, one per chat in per-chat mode, so distinct ad-hoc
  // chats never share a window. Lives inside sessionsPath (the day-file scan ignores it: not a `YYYY-MM-DD.jsonl`).
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
      this.windowDerivationStatusByChat.set(chatId, 'watermark');
    } else {
      const resolution = deriveWindowAnchor(this.archiveDir(chatId), realTailLength, this.archiveTailFor(chatId));
      verbatimFrom = resolution.anchor;
      this.windowDerivationStatusByChat.set(chatId, resolution.source);
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

  // The window as a derived snapshot of in-memory history + physical archive anchors. A malformed physical slot is
  // absent from history but remains represented by the valid messages' carried cursors.
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
    // A missing/stale watermark is recoverable from the newest day file. The source archive remains
    // authoritative; the next successful window save publishes the repaired tail metadata.
    this.archiveTailsByDir.set(archiveDir, current);
    if (persisted) {
      this.windowDerivationStatusByChat.set(chatId, 'fallback');
      console.warn(`[session:${chatId}] archive tail watermark stale; using recovery metadata`);
    }
  }

  // Persist the window snapshot (best-effort: a save failure must never break the turn; the archive on disk remains
  // the source of truth).
  private saveWindowFor(chatId: string): boolean {
    try {
      saveWindow(this.windowPath(chatId), this.deriveWindow(chatId));
      return true;
    } catch (e) {
      console.warn(`[session:${chatId}] window state save failed, continuing:`, summarizeErrorForLog(e));
      return false;
    }
  }

  // Resume from the window + day-file archive. Flat mode has one archive whose chatIds come from the entries; per-chat
  // mode has one archive subdirectory per chatId. An absent or corrupt window gives a fresh empty window at the
  // latest-day EOF. Never throws.
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

  // Rebuild one chat's in-memory history = [summary system message?, ...verbatim tail], where the tail is the
  // day-file lines after `verbatimFrom`. Sanitizes torn appends. Skips empty sessions.
  private resumeChat(chatId: string): void {
    const window = resolveWindow(this.windowPath(chatId), this.archiveDir(chatId));
    this.restoreArchiveTail(chatId, this.archiveDir(chatId), window.archiveTail);
    // Restore the last window-fill reading so the first post-restart turn evaluates triggers against the persisted
    // signal (not a cold zero).
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
