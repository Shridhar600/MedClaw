import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message, ToolSchema } from '../providers/types';
import type { LLMProvider, LLMResponse } from '../providers/types';
import type { ToolRegistry } from '../tools/registry';
import { type RotationConfig } from '../scheduler/rotation';
import { summarizeErrorForLog, secureMkdir, secureWrite, secureWriteViaTmp, secureAppend } from '../security';
import {
  dateKey,
  countDayFileLines,
  listDayFiles,
  walkBackAnchor,
  readLinesAfter,
  resolveWindow,
  saveWindow,
  type Anchor,
  type SessionWindow,
} from './session-window';

// The system-message prefix that marks a compaction summary in the in-context history. Held as one
// constant so compaction (write), the window snapshot (derive), and resume (render) agree byte-for-byte.
const SUMMARY_PREFIX = '[Previous conversation summary]\n';

interface Session {
  chatId: string;
  history: Message[];
  lastActiveAt: Date;
}

interface JsonlEntry {
  timestamp: string;
  role: Message['role'];
  content: string | null;
  chatId: string;
  tool_call_id?: string;
  tool_calls?: Message['tool_calls'];
  // Backward compatibility with previous camelCase format.
  toolCallId?: string;
  toolCalls?: Message['tool_calls'];
  // Backward compatibility with previously persisted format.
  toolName?: string;
  toolResult?: string;
}

interface CompactionConfig {
  enabled: boolean;
  triggerAtTokenPercent: number;
  memoryFlush: boolean;
  keepRecentTurns: number;
}

// P2b spec 14 §3 window triggers (structural twin of config's SessionWindowConfig — kept local so
// session.ts stays decoupled from the config module, matching the CompactionConfig precedent).
interface WindowConfig {
  pruneAtPercent: number;
  compactAtPercent: number;
  emergencyAtPercent: number;
  keepRecentTurns: number;
}

// A-M4: the new canonical constructor shape. Expand-contract — the legacy positional signature keeps
// working during the P2b Wave D-1 cutover and is removed once every caller is migrated.
export interface SessionManagerOptions {
  sessionsPath?: string;
  softResetMinutes?: number;
  hardResetMinutes?: number;
  provider?: LLMProvider;
  toolRegistry?: ToolRegistry;
  compaction?: CompactionConfig;
  /** P2b spec 14 §3 real-token window triggers (defaults 35/50/80/10 when absent). */
  window?: WindowConfig;
  /** P2b DD4 — the model's context window in tokens; falls back to `contextWindowFor` when unset. */
  contextWindow?: number;
  profileId?: string;
  rotationConfig?: Partial<RotationConfig>;
  /**
   * D1.2/A-MF5: day-file archive namespacing. `false` (registry-backed, one thread per profile) →
   * `<sessionsPath>/YYYY-MM-DD.jsonl`. `true` (no-registry / ad-hoc, per-chat isolation) →
   * `<sessionsPath>/<chatId>/YYYY-MM-DD.jsonl`. The Gateway sets it from whether a ProfileRegistry
   * is present.
   */
  perChatArchive?: boolean;
}

/**
 * D2.5: the minimal seam by which the SessionManager feeds each appended archive line to the
 * `session_search` FTS index (incremental indexing). Kept structural — NOT an import of the concrete
 * indexstore adapter — so session.ts (gateway-tier) has no dependency on the index implementation.
 * Best-effort: the caller wraps every call so an index failure degrades and never blocks a turn.
 */
export interface SessionTurnIndexer {
  indexTurn(file: string, line: number, role: string, ts: string, content: string): void;
}

// --- Compaction token-budget trigger (#15) --------------------------------
// A cheap safety-margin trigger, NOT exact accounting. `estimateTokens` is a
// chars/4 English heuristic (20-30% error is acceptable because we compact
// well before the real context limit); no tokenizer and no new dependency.
// I3: retry only transient upstream conditions. OpenAI SDK errors carry a
// numeric `status`; plain network failures (fetch TypeError) carry none.
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

export type WindowTrigger = 'none' | 'prune' | 'compact' | 'emergency';

/**
 * spec 14 §3 threshold table — the window-fill percentage maps to the compaction action. Bounds are
 * inclusive lower edges: `<prune` none; `[prune,compact)` prune; `[compact,emergency)` compact;
 * `>=emergency` emergency. Pure so the 34/35/49/50/80 boundaries are unit-tested directly.
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
  if (m.includes('kimi')) return 262144; // Kimi K2.5/K2.6/K2.7 — 256K (shipped default main model)
  return 8192; // medgemma / unknown
}

// --- Tool-call group integrity (#16) --------------------------------------
// OpenAI rejects any history where a `tool` message is not a response to a
// preceding `assistant`+`tool_calls`, or where an `assistant`+`tool_calls`
// is not immediately followed by its tool result(s). Compaction must never
// produce such a history.

// Is history[i] a clean place to START the kept (recent) slice? A `tool`
// message is never clean (it would be orphaned from its parent). An assistant
// is clean only when it does not continue a tool group (i.e. the previous
// message is not a tool result). user / system are always clean.
function isCleanBoundaryStart(history: Message[], i: number): boolean {
  const msg = history[i];
  if (!msg) return true;
  if (msg.role === 'tool') return false;
  if (msg.role === 'assistant') {
    const prev = history[i - 1];
    return !prev || prev.role !== 'tool';
  }
  return true;
}

// Compute the older/recent split index. Start at `length - keepRecent`, then
// move EARLIER (keep MORE in recent) until the boundary is clean. Never move
// later — that would drop content. Keeping a few extra recent turns is
// harmless.
export function computeCleanSplit(history: Message[], keepRecent: number): number {
  let split = Math.max(0, history.length - keepRecent);
  while (split > 0 && !isCleanBoundaryStart(history, split)) {
    split--;
  }
  return split;
}

// Defensive sanitizer (belt-and-braces even after the boundary snap, and
// protects any other provider call that replays a compacted history). Drops:
// leading/orphan `tool` messages (no matching assistant+tool_calls parent) and
// a trailing `assistant`+`tool_calls` with no following tool result.
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

// spec 14 §3 prune marker (in-window only — the day-file archive keeps the verbatim result, retrievable
// via session_search). One constant so the marker text is a single source of truth.
export const PRUNED_TOOL_MARKER = '[tool result pruned — session_search to retrieve]';

// spec 14 §3 / A-M6: prune keeps the LAST 5 TURNS verbatim (a "turn" = the span from one `user` message
// to the next). This is a DIFFERENT number + purpose from compaction's keepRecentTurns (10).
const PRUNE_LAST_TURNS = 5;

/**
 * spec 14 §3 prune: swap the CONTENT of `tool`-role messages that fall before the last `keepTurns`
 * turns with the pruned marker. Content-swap only — the message, its role, and its `tool_call_id` are
 * kept, so tool-group integrity and OpenAI ordering hold, and nothing is removed. Lossless: the disk
 * day-file line is untouched; the verbatim original is returned by session_search. A history with
 * `<= keepTurns` turns is returned unchanged.
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
 * spec 14 §4.2: give every summary bullet a resolving `sessions/<file>#L<n>` anchor so nothing the
 * summary references is unreachable (the agent can session_search the specific line). Anchors are drawn
 * from `rangeAnchors` — the day-file lines of the turns that were summarized — spread across the bullets
 * (clamped), so each anchor is real and in-range. A line that already carries an anchor is left as-is;
 * blank lines are skipped. No LLM self-citation dependency.
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

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private softResetMs: number;
  private hardResetMs: number;
  private sessionsPath: string;
  private operationQueues: Map<string, Array<() => Promise<void>>> = new Map();
  private readonly llmProvider?: LLMProvider;
  private readonly toolRegistry?: ToolRegistry;
  private readonly compactionConfig?: CompactionConfig;
  private readonly windowConfig?: WindowConfig;
  private readonly contextWindow?: number;
  private readonly profileId: string;
  // DD3 (A-MF1): the last window-fill reading per chat — real `usage.promptTokens` (estimated:false) or
  // a chars/4 fallback (estimated:true). Persisted in the window state; seeded from it on resume.
  // `triggered` marks a reading already consumed by a prune/compact/emergency this cycle so the SAME
  // stale reading cannot re-fire every turn (A-MF3); the next recordPromptUsage clears it.
  private readonly lastPromptTokensByChat: Map<string, { tokens: number; estimated: boolean; triggered?: boolean }> = new Map();
  // A-MF3: the in-flight background compaction per chat, so a ≥50% trigger never starts a second pipeline.
  private readonly compactionInFlight: Map<string, Promise<void>> = new Map();
  private readonly rotationConfig?: Partial<RotationConfig>;
  private readonly perChatArchive: boolean;
  // D1.3 (A-H2): the current physical non-empty line count of each day file, keyed by full day-file
  // path. Seeded FROM DISK on first touch this process (in-memory tracking is lost on restart and
  // `secureAppend` does not fsync), then advanced as we append. Every anchor is computed from this
  // count, so a fresh manager continues the numbering instead of restarting at 1.
  private readonly dayFileLineCounts: Map<string, number> = new Map();
  // F8: compaction LLM calls run at 'background' semaphore priority so they never starve or collide
  // with user turns. Injected by the Gateway (setter — the semaphore is created alongside). When
  // unset (tests / no semaphore), the call runs directly. prepareHistory always runs BEFORE the
  // AgentLoop acquires the semaphore, so this background acquire cannot self-deadlock (v2-H-4).
  private runBackground?: <T>(fn: () => Promise<T>) => Promise<T>;
  // D2.5: the session_search FTS index. When wired, recordTurn feeds each appended archive line to it
  // (best-effort). Optional — no index ⇒ no incremental indexing (session_search unavailable / degraded).
  private turnIndex?: SessionTurnIndexer;

  /** Wire compaction LLM calls through the semaphore at background priority (F8). */
  setBackgroundRunner(run: <T>(fn: () => Promise<T>) => Promise<T>): void {
    this.runBackground = run;
  }

  /** Wire the session_search FTS index for incremental per-turn indexing (D2.5). */
  setTurnIndex(index: SessionTurnIndexer): void {
    this.turnIndex = index;
  }

  // D3.4 spec 14 §4 step 4: the sink that copies each compaction summary (anchored bullets) to today's
  // daily log `## Session summary`. Wired by the Gateway through the WriteQueue + index refresh. Optional
  // and best-effort — a sink failure never fails compaction.
  private summarySink?: (anchoredSummary: string) => Promise<void>;

  /** Wire the compaction-summary → daily-log sink (D3.4 / spec 14 §4 step 4). */
  setSummarySink(sink: (anchoredSummary: string) => Promise<void>): void {
    this.summarySink = sink;
  }

  /** The resolved day-file archive root — the Gateway builds the search index over this same directory. */
  get sessionsDir(): string {
    return this.sessionsPath;
  }

  private runLLM<T>(fn: () => Promise<T>): Promise<T> {
    return this.runBackground ? this.runBackground(fn) : fn();
  }

  // I3: compaction LLM calls are the largest requests a session makes, so on
  // shared-pool providers they hit transient upstream rate limits most often
  // (live soak 2026-08-25: both attempts died on a 429 that passed seconds
  // later). Bounded retry with linear backoff before the F6 degrade kicks in.
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
    // A-M4 expand-contract: accept the new options object OR the legacy positional args.
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
    this.migrateLegacySessions();
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
      lastActiveAt: new Date(),
    };
    this.sessions.set(chatId, created);
    return created;
  }

  getHistory(chatId: string): Message[] {
    return this.sessions.get(chatId)?.history ?? [];
  }

  getLastActiveAt(chatId: string): Date | undefined {
    return this.sessions.get(chatId)?.lastActiveAt;
  }

  getMostRecentChatId(): string | undefined {
    let latest: Session | undefined;
    for (const session of this.sessions.values()) {
      if (!latest || session.lastActiveAt.getTime() > latest.lastActiveAt.getTime()) {
        latest = session;
      }
    }
    return latest?.chatId;
  }

  async prepareHistory(chatId: string): Promise<Message[]> {
    return this.enqueue(chatId, async () => {
      const session = this.sessions.get(chatId);
      if (!session) {
        return [];
      }

      // P2b/D1.4 (DD10): the perpetual thread NEVER idle-resets. spec 14 §3 real-token triggers replace
      // the old chars/4 budget heuristic: the last window-fill reading maps to prune / compact / emergency.
      const trigger = this.evaluateWindowTrigger(chatId);
      if (trigger !== 'none') {
        // A-MF3: consume the reading so the SAME stale value cannot re-fire the trigger every turn (the
        // reading only changes on the next recordPromptUsage). Marked before the action so a background
        // compaction started here is not re-started by a concurrent prepareHistory.
        const reading = this.lastPromptTokensByChat.get(chatId);
        if (reading) reading.triggered = true;

        if (trigger === 'prune') {
          // ≥35%, no LLM — runs synchronously in this queued op (lossless; day file untouched).
          session.history = pruneToolResults(session.history, PRUNE_LAST_TURNS);
          this.saveWindowFor(chatId);
        } else if (trigger === 'compact') {
          // ≥50% — run the LLM pipeline in the BACKGROUND (a separate queued op, applied against the live
          // tail); return the current (possibly over-budget) window now, the compacted one lands later.
          this.startBackgroundCompaction(chatId);
        } else if (trigger === 'emergency') {
          // ≥80% — compact BEFORE the turn proceeds (await). A-M3: always runs, even enabled:false.
          await this.runEmergencyCompaction(chatId);
        }
      }

      // DD2: the returned history IS the window — the summary system message (if any) followed by the
      // verbatim tail — sanitized so this boundary never emits an OpenAI-rejectable history (#16).
      return stripOrphanToolMessages([...(this.sessions.get(chatId)?.history ?? [])]);
    });
  }

  // spec 14 §3: map the current window-fill reading to a trigger. A reading already consumed this cycle
  // (`triggered`) yields 'none' so the same stale value never re-fires (A-MF3).
  private evaluateWindowTrigger(chatId: string): WindowTrigger {
    const reading = this.lastPromptTokensByChat.get(chatId);
    if (!reading || reading.triggered) return 'none';
    return windowTriggerFor(this.windowFillPercent(chatId), this.windowThresholds());
  }

  // A-MF3: start a background compaction as a SEPARATE queued op (fire-and-forget) so it applies against
  // the live tail after the current op, without blocking the returned window. In-flight guarded so a
  // second ≥50% trigger never starts a second pipeline. Never rejects out (best-effort).
  private startBackgroundCompaction(chatId: string): void {
    if (this.compactionInFlight.has(chatId)) return;
    const p = this.enqueue(chatId, async () => {
      await this.runCompactionInternal(chatId);
      this.saveWindowFor(chatId);
    })
      .catch((e) => console.warn(`[session:${chatId}] background compaction failed:`, summarizeErrorForLog(e)))
      .finally(() => this.compactionInFlight.delete(chatId));
    this.compactionInFlight.set(chatId, p);
  }

  // ≥80% emergency (A-MF3 awaits it). A-M3 escape valve: emergency ALWAYS runs even when
  // compaction.enabled=false — as a no-LLM clean-split truncate — so a disabled config cannot overflow.
  private async runEmergencyCompaction(chatId: string): Promise<void> {
    if (this.compactionConfig?.enabled === false) {
      const session = this.sessions.get(chatId);
      if (session) {
        const keepRecent = Math.max(1, this.windowThresholds().keepRecentTurns);
        const split = computeCleanSplit(session.history, keepRecent);
        session.history = stripOrphanToolMessages(session.history.slice(split));
      }
    } else {
      await this.runCompactionInternal(chatId);
    }
    this.saveWindowFor(chatId);
  }

  async recordTurn(chatId: string, turnTrace: Message[]): Promise<Anchor[]> {
    return this.enqueue(chatId, async () => {
      if (turnTrace.length === 0) {
        return [];
      }
      // Persist-first: append to the JSONL BEFORE mutating in-memory state.
      // If the append/rotation throws, the enqueue promise rejects and the
      // in-memory session.history never sees the turn — no memory/disk
      // divergence.
      const anchors = await this.appendMessagesToJsonl(chatId, turnTrace);
      const session = this.getOrCreateSessionState(chatId);
      session.history.push(...turnTrace);
      session.lastActiveAt = new Date();
      this.sessions.set(chatId, session);
      // D1.5: persist the window snapshot so a restart resumes this tail from the day-file archive.
      this.saveWindowFor(chatId);
      return anchors;
    });
  }

  /**
   * D1.3: the current EOF anchor of `chatId`'s day file for `now` — `{file: <day-file basename>,
   * line: <physical non-empty line count>}`. Line count is re-derived from disk on first touch this
   * process (A-H2). Used by `/new` (window archive at EOF, DD9) and compaction (`verbatimFrom`, D3).
   */
  currentDayFileAnchor(chatId: string, now: Date = new Date()): Anchor {
    return { file: `${dateKey(now)}.jsonl`, line: this.dayFileLineCount(this.dayFilePath(chatId, now)) };
  }

  async addTurn(chatId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
    await this.recordTurn(chatId, [userMsg, assistantMsg]);
  }

  /**
   * DD3 / A-MF1 / A-MF3: record the window-fill signal after a completed turn. `tokens` = the LAST
   * provider call's `usage.promptTokens` (`AgentRunResult.lastPromptTokens`); `undefined` ⇒ a flagged
   * chars/4 estimate over the current window (spec 14 §3). Routed through the op queue (mutates +
   * persists window state) so it serializes with recordTurn / prepareHistory / compaction.
   */
  async recordPromptUsage(chatId: string, tokens?: number): Promise<void> {
    await this.enqueue(chatId, async () => {
      const reading = tokens !== undefined
        ? { tokens, estimated: false }
        : { tokens: estimateTokens(this.sessions.get(chatId)?.history ?? []), estimated: true };
      this.lastPromptTokensByChat.set(chatId, reading);
      this.saveWindowFor(chatId);
    });
  }

  /**
   * DD9 `/new`: start a fresh CONTEXT window. Clear the in-memory history + the fill signal and drop the
   * window snapshot so resume replays nothing. The append-only day-file archive is UNTOUCHED (DD1) — the
   * disk log continues with contiguous line numbers and stays searchable via session_search. The old
   * `archive/` + `summaries/` side-files are retired (replaced by day files + daily-log summaries).
   */
  async resetSession(chatId: string): Promise<void> {
    await this.enqueue(chatId, async () => {
      this.sessions.delete(chatId);
      this.lastPromptTokensByChat.delete(chatId);
      try {
        const wp = this.windowPath(chatId);
        if (fs.existsSync(wp)) fs.unlinkSync(wp);
      } catch (e) {
        console.warn(`[session:${chatId}] window state clear failed, continuing:`, summarizeErrorForLog(e));
      }
    });
  }

  async runCompaction(chatId: string): Promise<void> {
    await this.enqueue(chatId, async () => {
      await this.runCompactionInternal(chatId);
      this.saveWindowFor(chatId); // D1.5: persist the post-compaction window snapshot
    });
  }

  /**
   * spec 14 §3 prune (≥35%): replace in-window tool results older than the last 5 turns with the marker
   * (lossless — the day file is untouched; session_search retrieves the verbatim original). No LLM;
   * runs synchronously inside the op queue (A-MF3). The window pointer is unchanged (content-swap only),
   * so a restart replays the verbatim tail (A-M5: prune does not survive restart, re-fires on fill).
   */
  async pruneWindow(chatId: string): Promise<void> {
    await this.enqueue(chatId, async () => {
      const session = this.sessions.get(chatId);
      if (!session) return;
      session.history = pruneToolResults(session.history, PRUNE_LAST_TURNS);
      this.saveWindowFor(chatId);
    });
  }

  // DD4: the effective context window — an explicit config value wins over the per-model table.
  private effectiveContextWindow(): number {
    return this.contextWindow ?? contextWindowFor(this.llmProvider?.modelName);
  }

  /**
   * The current window-fill percentage for `chatId` (spec 14 §3): the last recorded token reading (real
   * `usage.promptTokens` or a flagged chars/4 estimate) over the effective context window. 0 when no
   * usage has been recorded yet.
   */
  windowFillPercent(chatId: string): number {
    const reading = this.lastPromptTokensByChat.get(chatId);
    if (!reading) return 0;
    const window = this.effectiveContextWindow();
    return window > 0 ? (reading.tokens / window) * 100 : 0;
  }

  // The window thresholds + keepRecentTurns in effect (config, else the spec-14 defaults 35/50/80/10).
  private windowThresholds(): WindowConfig {
    return {
      pruneAtPercent: this.windowConfig?.pruneAtPercent ?? 35,
      compactAtPercent: this.windowConfig?.compactAtPercent ?? 50,
      emergencyAtPercent: this.windowConfig?.emergencyAtPercent ?? 80,
      keepRecentTurns: this.windowConfig?.keepRecentTurns ?? this.compactionConfig?.keepRecentTurns ?? 10,
    };
  }

  private async runCompactionInternal(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;

    const keepRecent = Math.max(1, this.windowThresholds().keepRecentTurns);
    const doFlush = this.compactionConfig?.memoryFlush ?? true;

    if (!this.llmProvider) {
      // #16: snap the boundary so we never start the kept slice on an orphan `tool` message, then
      // sanitize belt-and-braces. D1.6: in-memory-only — the day-file archive is untouched (DD1).
      const split = computeCleanSplit(session.history, keepRecent);
      session.history = stripOrphanToolMessages(session.history.slice(split));
      return;
    }

    // #16: split on a CLEAN boundary (never mid tool-call group) so recentTurns
    // does not start with a dangling `tool` and olderTurns does not end with an
    // unmatched assistant+tool_calls.
    const split = computeCleanSplit(session.history, keepRecent);
    const recentTurns = session.history.slice(split);
    const olderTurns = session.history.slice(0, split);

    if (olderTurns.length === 0) {
      session.history = stripOrphanToolMessages(recentTurns);
      return;
    }

    // §4.2: the day-file anchors of the older REAL messages (excluding any leading compaction summary),
    // used to anchor the summary bullets. The tail maps 1:1 to the day-file lines after verbatimFrom
    // (Option C), and compaction never rewrites the day files (DD1), so these anchors always resolve.
    const first = session.history[0];
    const hasSummary = !!first && first.role === 'system'
      && typeof first.content === 'string' && first.content.startsWith(SUMMARY_PREFIX);
    const olderRealCount = split - (hasSummary ? 1 : 0);
    const rangeAnchors: Anchor[] = readLinesAfter(this.archiveDir(chatId), this.deriveWindow(chatId).verbatimFrom)
      .slice(0, Math.max(0, olderRealCount))
      .map((l) => ({ file: l.file, line: l.line }));

    if (doFlush && this.toolRegistry) {
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
            parameters: {
              type: 'object' as const,
              properties: t.parameters.properties,
              required: t.parameters.required,
            },
          },
        }));

        const flushResponse = await this.runLLMWithRetry<LLMResponse>('compaction-flush', () => this.llmProvider!.chat(
          [
            { role: 'system', content: flushPrompt },
            // #16: sanitize before sending — a clean split already prevents a
            // trailing unmatched assistant+tool_calls, this is belt-and-braces.
            ...stripOrphanToolMessages(olderTurns),
            { role: 'user', content: 'Persist what should be remembered before compaction.' },
          ],
          toolSchemas,
        ));

        if (flushResponse.type === 'tool_call') {
          for (const c of flushResponse.toolCalls) {
            await this.toolRegistry.execute(c.name, c.arguments);
          }
        }
      } catch (e) {
        // Provider error messages can echo transcript PHI — sanitized frame only.
        console.warn('[session] Flush turn failed:', summarizeErrorForLog(e));
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
        { role: 'user', content: JSON.stringify(olderTurns) },
      ]));

      const summaryText =
        summaryResponse.type === 'text' && summaryResponse.text.trim().length > 0
          ? summaryResponse.text.trim()
          : null;
      if (!summaryText) {
        // spec 14 §4: an empty summary is a failed step — keep the OLD window intact (never lose the
        // thread), retry on the next trigger. Do NOT drop the older turns unsummarized.
        console.warn('[session] Compaction produced no summary; keeping the current window.');
        return;
      }

      // §4.2 anchor the bullets, then assemble the new window (§4.3): summary (prepended) + last-N.
      const anchored = anchorSummaryBullets(summaryText, rangeAnchors);
      const assembled: Message[] = [
        { role: 'system', content: `${SUMMARY_PREFIX}${anchored}` },
        ...recentTurns,
      ];
      // #16 belt-and-braces after the clean split. DD1: the day-file archive is NEVER rewritten; the
      // caller persists the window snapshot (saveWindowFor).
      session.history = stripOrphanToolMessages(assembled);

      // §4 step 4: copy the anchored bullets to today's daily log (best-effort — a sink failure must not
      // fail compaction; the window is already updated).
      if (this.summarySink) {
        try {
          await this.summarySink(anchored);
        } catch (e) {
          console.warn('[session] Session-summary daily-log copy failed:', summarizeErrorForLog(e));
        }
      }
    } catch (e) {
      // spec 14 §4: any step failing ⇒ keep the OLD window (do not truncate to recent), log sanitized,
      // retry next trigger. Provider error messages can echo transcript PHI — sanitized frame only.
      console.warn('[session] Compact turn failed (keeping current window):', summarizeErrorForLog(e));
    }
  }

  private async appendMessagesToJsonl(chatId: string, messages: Message[]): Promise<Anchor[]> {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const lines = messages.map(msg => JSON.stringify(this.serializeEntry(chatId, msg, now)));
    const block = lines.join('\n') + '\n';
    const dayFilePath = this.dayFilePath(chatId, nowDate);
    // D1.3: assign each appended message a stable {file, line} anchor from the re-derived count. The
    // first appended message takes line `count+1`; the file basename is the anchor's `file`.
    const startLine = this.dayFileLineCount(dayFilePath);
    const dayFile = `${dateKey(nowDate)}.jsonl`;
    const anchors: Anchor[] = messages.map((_msg, i) => ({ file: dayFile, line: startLine + i + 1 }));
    // D1.6: the append-only day-file archive is the SOLE store (DD1) — the legacy active-file dual-write
    // is ended, and day files are NEVER size-rotated (DD8; anchors must stay stable). Persist-first still
    // holds: a failed append rejects the enqueue and `recordTurn` never mutates in-memory state.
    secureAppend(dayFilePath, block);
    this.dayFileLineCounts.set(dayFilePath, startLine + lines.length);
    // D2.5: incrementally index each appended line for session_search (best-effort — an index failure
    // degrades and never blocks the turn). The `{file, line}` anchor is the day-file's physical line, so
    // an incrementally-indexed row and a disk rebuild resolve to the same JSONL line (idempotent upsert).
    // Skip null/empty-content messages (e.g. an assistant tool-call carrier) — nothing textual to search.
    if (this.turnIndex) {
      try {
        for (let i = 0; i < messages.length; i++) {
          const content = messages[i].content;
          if (typeof content === 'string' && content.length > 0) {
            this.turnIndex.indexTurn(anchors[i].file, anchors[i].line, messages[i].role, now, content);
          }
        }
      } catch (e) {
        console.warn(`[session:${chatId}] turn indexing failed, continuing:`, summarizeErrorForLog(e));
      }
    }
    return anchors;
  }

  // D1.3 (A-H2): the day file's current physical non-empty line count, seeded FROM DISK on first
  // touch this process (never trusted across a restart — no fsync), then advanced in memory on append.
  private dayFileLineCount(dayFilePath: string): number {
    let count = this.dayFileLineCounts.get(dayFilePath);
    if (count === undefined) {
      count = countDayFileLines(dayFilePath);
      this.dayFileLineCounts.set(dayFilePath, count);
    }
    return count;
  }

  // D1.2/A-MF5: the append-only archive path for `chatId` on the day of `now`. Flat per profile
  // (registry mode) or namespaced per chat (no-registry mode). Day boundaries use the shared UTC
  // `dateKey` (A-H3) so a turn after local midnight lands in the correct file.
  private dayFilePath(chatId: string, now: Date): string {
    const day = `${dateKey(now)}.jsonl`;
    return this.perChatArchive
      ? path.join(this.sessionsPath, chatId, day)
      : path.join(this.sessionsPath, day);
  }

  private serializeEntry(chatId: string, msg: Message, timestamp: string): JsonlEntry {
    const entry: JsonlEntry = {
      timestamp,
      role: msg.role,
      content: msg.content ?? null,
      chatId,
    };
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

  // D1.5/A-MF5: the per-chat window state file. Registry mode = one per-profile window; no-registry
  // mode = per-chat so distinct ad-hoc chats never share a window (N-2). Lives inside sessionsPath
  // (test-isolated; the day-file scan ignores it — it is not a `YYYY-MM-DD.jsonl`).
  private windowPath(chatId: string): string {
    return this.perChatArchive
      ? path.join(this.sessionsPath, `session-window.${chatId}.json`)
      : path.join(this.sessionsPath, 'session-window.json');
  }

  // D1.5/A-MF5: the day-file archive directory for `chatId` — flat per profile (registry) or namespaced
  // per chat (no-registry). Mirrors `dayFilePath`.
  private archiveDir(chatId: string): string {
    return this.perChatArchive ? path.join(this.sessionsPath, chatId) : this.sessionsPath;
  }

  // D1.5: the window as a DERIVED snapshot of the in-memory history + the archive position. summaryBlock
  // = the leading compaction summary (if any); verbatimFrom = the archive EOF walked back by the verbatim
  // tail length. This holds because every non-summary message in `history` is exactly the last-K lines of
  // the append-only day archive (compaction never rewrites day files — DD1).
  private deriveWindow(chatId: string): SessionWindow {
    const history = this.sessions.get(chatId)?.history ?? [];
    const first = history[0];
    const hasSummary =
      !!first && first.role === 'system' && typeof first.content === 'string' && first.content.startsWith(SUMMARY_PREFIX);
    const summaryBlock = hasSummary ? (first.content as string).slice(SUMMARY_PREFIX.length) : '';
    const realTailLength = history.length - (hasSummary ? 1 : 0);
    const window: SessionWindow = { summaryBlock, verbatimFrom: walkBackAnchor(this.archiveDir(chatId), realTailLength) };
    // DD3: carry the last window-fill reading so a restart resumes the trigger signal (A3).
    const usage = this.lastPromptTokensByChat.get(chatId);
    if (usage) {
      window.lastPromptTokens = usage.tokens;
      window.lastPromptTokensEstimated = usage.estimated;
    }
    return window;
  }

  // D1.5: persist the window snapshot (best-effort — a save failure must never break the turn, per
  // resilience.md; the archive on disk remains the source of truth).
  private saveWindowFor(chatId: string): void {
    try {
      saveWindow(this.windowPath(chatId), this.deriveWindow(chatId));
    } catch (e) {
      console.warn(`[session:${chatId}] window state save failed, continuing:`, summarizeErrorForLog(e));
    }
  }

  // D1.5: resume from the window + day-file archive (NOT the legacy active file). Registry mode has one
  // flat archive whose chatId(s) come from the entries; no-registry mode has one archive subdirectory per
  // chatId. Absent/corrupt window ⇒ a fresh empty window at the latest-day EOF (A-L6). Never throws.
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
        if (e.isDirectory() && listDayFiles(this.archiveDir(e.name)).length > 0) {
          this.resumeChat(e.name);
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

  // D1.5: rebuild one chat's in-memory history = [summary system message?, ...verbatim tail], where the
  // tail is the day-file lines after `verbatimFrom`. Sanitize torn appends (#16). Skip empty sessions.
  private resumeChat(chatId: string): void {
    const window = resolveWindow(this.windowPath(chatId), this.archiveDir(chatId));
    // DD3/A3: restore the last window-fill reading so the first post-restart turn evaluates triggers
    // against the persisted signal (not a cold zero).
    if (window.lastPromptTokens !== undefined) {
      this.lastPromptTokensByChat.set(chatId, {
        tokens: window.lastPromptTokens,
        estimated: window.lastPromptTokensEstimated ?? false,
      });
    }
    const tail: Message[] = [];
    let lastTimestamp: Date | undefined;
    for (const line of readLinesAfter(this.archiveDir(chatId), window.verbatimFrom)) {
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(line.raw) as JsonlEntry;
      } catch {
        continue; // malformed physical slot — skip when reconstructing (A-H2)
      }
      if (entry.chatId !== chatId) continue; // registry mode: only this chat's entries
      const message = this.entryToMessage(entry);
      if (!message) continue;
      tail.push(message);
      const ts = new Date(entry.timestamp);
      if (!Number.isNaN(ts.getTime())) lastTimestamp = ts;
    }

    const rendered: Message[] = [
      ...(window.summaryBlock ? [{ role: 'system' as const, content: SUMMARY_PREFIX + window.summaryBlock }] : []),
      ...tail,
    ];
    const history = stripOrphanToolMessages(rendered);
    if (history.length === 0) return;

    this.sessions.set(chatId, { chatId, history, lastActiveAt: lastTimestamp ?? new Date() });
  }

  private chatIdOfRaw(raw: string): string | undefined {
    try {
      return (JSON.parse(raw) as JsonlEntry).chatId;
    } catch {
      return undefined;
    }
  }

  // D1.6/A-MF2: one-time migration of legacy `active-<chatId>.jsonl` files into the append-only day-file
  // archive, sentinel-gated by `<sessionsPath>/.migrated`. Each day file is built ATOMICALLY (tmp+rename)
  // and WRITE-IF-ABSENT (never a blind overwrite), so a retry after a crash — or after live turns already
  // appended to today's day file — can never destroy live-recorded data (N-1). Registry mode pools all
  // sources into shared root day files; no-registry mode buckets each source into its own `<chatId>/`
  // subdir (A-MF5/N-3). Best-effort: any failure logs sanitized and leaves the sentinel UNWRITTEN so the
  // migration retries next boot; the daemon never crashes.
  private migrateLegacySessions(): void {
    const sentinel = path.join(this.sessionsPath, '.migrated');
    try {
      if (fs.existsSync(sentinel)) return;
      const legacy = fs.readdirSync(this.sessionsPath).filter((f) => f.startsWith('active-') && f.endsWith('.jsonl'));
      if (legacy.length === 0) {
        secureWrite(sentinel, new Date().toISOString());
        return;
      }

      // Parse every legacy entry, preserving source-file order (sorted) then in-file order — the tie-break
      // for entries sharing a timestamp. Malformed / invalid-timestamp lines are skipped with a sanitized
      // (content-free) warn.
      interface Row { chatId: string; day: string; ts: number; order: number; raw: string }
      const rows: Row[] = [];
      let order = 0;
      for (const file of legacy.sort()) {
        const chatId = file.replace(/^active-/, '').replace(/\.jsonl$/, '');
        const lines = fs.readFileSync(path.join(this.sessionsPath, file), 'utf-8').split('\n').filter((l) => l.length > 0);
        for (const raw of lines) {
          let entry: JsonlEntry;
          try {
            entry = JSON.parse(raw) as JsonlEntry;
          } catch {
            console.warn(`[session] migration: skipping a malformed line in ${file}`);
            continue;
          }
          const ts = new Date(entry.timestamp).getTime();
          if (Number.isNaN(ts)) {
            console.warn(`[session] migration: skipping an entry with an invalid timestamp in ${file}`);
            continue;
          }
          rows.push({ chatId, day: dateKey(new Date(ts)), ts, order: order++, raw });
        }
      }

      // Bucket by target day file, sort each day stably by (timestamp, then source order for ties), and
      // write it WRITE-IF-ABSENT. The raw serialized line is preserved verbatim (no re-serialization).
      const buckets = new Map<string, Row[]>();
      for (const r of rows) {
        const targetDir = this.perChatArchive ? path.join(this.sessionsPath, r.chatId) : this.sessionsPath;
        const key = `${targetDir} ${r.day}`;
        (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(r);
      }
      const archiveDirs = new Set<string>();
      for (const [key, arr] of buckets) {
        const sep = key.indexOf(' ');
        const targetDir = key.slice(0, sep);
        const day = key.slice(sep + 1);
        arr.sort((x, y) => x.ts - y.ts || x.order - y.order); // Array.sort is stable ⇒ ties keep source order
        const dayPath = path.join(targetDir, `${day}.jsonl`);
        if (!fs.existsSync(dayPath)) {
          secureMkdir(targetDir);
          secureWriteViaTmp(dayPath, arr.map((r) => r.raw).join('\n') + '\n');
        }
        archiveDirs.add(targetDir);
      }

      // Seed the window(s) to the last keepRecentTurns verbatim (DD12), write-if-absent. Registry = one
      // window; no-registry = per-chat.
      const keepRecent = Math.max(1, this.compactionConfig?.keepRecentTurns ?? 10);
      if (this.perChatArchive) {
        for (const targetDir of archiveDirs) {
          this.seedWindowIfAbsent(this.windowPath(path.basename(targetDir)), targetDir, keepRecent);
        }
      } else {
        this.seedWindowIfAbsent(this.windowPath(''), this.sessionsPath, keepRecent);
      }

      secureWrite(sentinel, new Date().toISOString()); // LAST — commits the migration
    } catch (e) {
      // Boot-failure policy (A-MF2): warn sanitized, sentinel left UNWRITTEN (retry next boot), never crash.
      console.warn('[session] legacy migration failed, will retry next boot:', summarizeErrorForLog(e));
    }
  }

  private seedWindowIfAbsent(windowPath: string, archiveDir: string, keepRecent: number): void {
    if (fs.existsSync(windowPath)) return;
    saveWindow(windowPath, { summaryBlock: '', verbatimFrom: walkBackAnchor(archiveDir, keepRecent) });
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
