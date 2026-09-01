import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message, ToolSchema } from '../providers/types';
import type { LLMProvider, LLMResponse } from '../providers/types';
import type { ToolRegistry } from '../tools/registry';
import { type RotationConfig } from '../scheduler/rotation';
import {
  summarizeErrorForLog,
  secureMkdir,
  secureWriteViaTmp,
  secureAppend,
  PathContainmentError,
  resolveContainedPath,
} from '../security';
import {
  dateKey,
  countDayFileLines,
  listDayFiles,
  walkBackAnchor,
  anchorBefore,
  readLinesAfter,
  latestDayFileEof,
  resolveWindow,
  saveWindow,
  type Anchor,
  type SessionWindow,
} from './session-window';

// The system-message prefix that marks a compaction summary in the in-context history. Held as one
// constant so compaction (write), the window snapshot (derive), and resume (render) agree byte-for-byte.
const SUMMARY_PREFIX = '[Previous conversation summary]\n';

// HIGH-1: upper bound on a single day file the nightly sweep will slurp with a synchronous read
// (64 MiB — orders of magnitude above any real day of chat). A larger file is skipped, not read.
const MAX_DAY_FILE_READ_BYTES = 64 * 1024 * 1024;

interface Session {
  chatId: string;
  history: Message[];
  /** One physical archive cursor per history message; summary messages carry no cursor. */
  historyAnchors: Array<Anchor | undefined>;
  lastActiveAt: Date;
}

// A-H1 provenance for the nightly sweep: 'chat' = a real user/agent turn (the default, and what an
// absent field means — legacy/migrated entries stay sweepable); 'heartbeat'/'system' = daemon-authored,
// never mined for capture misses.
export type JsonlOrigin = 'chat' | 'heartbeat' | 'system';

interface JsonlEntry {
  timestamp: string;
  role: Message['role'];
  content: string | null;
  chatId: string;
  origin?: JsonlOrigin;
  tool_call_id?: string;
  tool_calls?: Message['tool_calls'];
  // Backward compatibility with previous camelCase format.
  toolCallId?: string;
  toolCalls?: Message['tool_calls'];
  // Backward compatibility with previously persisted format.
  toolName?: string;
  toolResult?: string;
}

interface SessionMigrationSentinel {
  version: 1;
  completed: true;
  completedAt: string;
}

function isValidSessionMigrationSentinel(filePath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SessionMigrationSentinel>;
    return parsed.version === 1
      && parsed.completed === true
      && typeof parsed.completedAt === 'string'
      && !Number.isNaN(new Date(parsed.completedAt).getTime());
  } catch {
    return false;
  }
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

// A snapshot of what a compaction will summarize, captured under the write queue so the LLM can then run
// OFF the queue (H2). `historyRef` is the identity of the history array at snapshot time — the apply
// aborts if it was replaced since (A-MF3 live-tail re-check). `olderReal` excludes any leading summary.
interface CompactionSnapshot {
  historyRef: Message[];
  historyAnchorsRef: Array<Anchor | undefined>;
  split: number;
  oldSummary: string;
  olderReal: Message[];
  rangeAnchors: Anchor[];
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
  /** Optional legacy global session directory to migrate into this archive before it is served. */
  legacySessionsPath?: string;
}

/**
 * D2.5: the minimal seam by which the SessionManager feeds each appended archive line to the
 * `session_search` FTS index (incremental indexing). Kept structural — NOT an import of the concrete
 * indexstore adapter — so session.ts (gateway-tier) has no dependency on the index implementation.
 * Best-effort: the caller wraps every call so an index failure degrades and never blocks a turn.
 */
export interface SessionTurnIndexer {
  indexTurn(chatId: string, file: string, line: number, role: string, ts: string, content: string): void;
  /** H5: durably flag a swallowed incremental-index failure so the next boot reconciles the hole. */
  markDirty?(): void;
  /** C-12: rebuild derived rows after migration appends records at new physical anchors. */
  reconcileFromDayFiles?(): void;
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

// M2: the chars/4 fallback (used only when a provider omits usage) counts the session history but NOT the
// system prompt (SAFETY + assembled memory) and tool schemas the provider actually received — those can be
// several thousand tokens. Add a conservative overhead so the fallback errs toward triggering compaction
// rather than under-reporting a large real prompt as near-zero. Real usage readings never use this.
const FALLBACK_SYSTEM_OVERHEAD_TOKENS = 3000;

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
// is not immediately followed by its tool result(s). Compaction splits on a
// turn (user-message) boundary — never mid-group — and `stripOrphanToolMessages`
// is the belt-and-braces sanitizer that guarantees a valid history regardless.

// H4 / A-M6: turn-aware retention split. A "turn" = the span from a `user` message to the next `user`
// message (same definition prune uses). The kept (recent) slice starts ON a user message, so it always
// begins with the user's question and NEVER an orphaned tool group or a half-turn (spec 14 §4 keeps the
// last `keepTurns` TURNS, not messages). Returns the index at which the recent slice begins; the older
// slice is history[0..split). Keeps everything (split 0) when there are fewer turns than `keepTurns`.
export function turnAwareSplit(history: Message[], keepTurns: number): number {
  if (keepTurns <= 0) return history.length;
  const userIdx: number[] = [];
  for (let i = 0; i < history.length; i++) if (history[i].role === 'user') userIdx.push(i);
  if (userIdx.length <= keepTurns) return 0; // fewer complete turns than we keep ⇒ keep all
  return userIdx[userIdx.length - keepTurns]; // the user message that starts the last `keepTurns` turns
}

// M3: strip any `sessions/<file>#L<n>` anchor a model summary may contain, so every stored anchor is
// application-supplied and range-validated (never a model-fabricated line that could point out of range
// or at a nonexistent file). Removes an optional wrapping "( … )" and trailing whitespace around it.
function stripModelAnchors(text: string): string {
  return text.replace(/\s*\(?sessions\/\S+#L\d+\)?/g, '');
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

// H11: true when the day file exists and its last byte is not '\n' (a torn/external write). Reads only
// the final byte (via a positioned read) — never the whole file. Any error ⇒ treat as a normal append.
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
  private readonly legacyMigrationComplete: boolean;
  // DD3 (A-MF1): the last window-fill reading per chat — real `usage.promptTokens` (estimated:false) or
  // a chars/4 fallback (estimated:true). Persisted in the window state; seeded from it on resume.
  // `triggered` marks a reading already consumed by a prune/compact/emergency this cycle so the SAME
  // stale reading cannot re-fire every turn (A-MF3); the next recordPromptUsage clears it.
  private readonly lastPromptTokensByChat: Map<string, { tokens: number; estimated: boolean; triggered?: boolean }> = new Map();
  // A-MF3: the in-flight background compaction per chat, so a ≥50% trigger never starts a second pipeline.
  private readonly compactionInFlight: Map<string, Promise<void>> = new Map();
  private readonly rotationConfig?: Partial<RotationConfig>;
  private readonly perChatArchive: boolean;
  private readonly legacySessionsPath?: string;
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
  // C-12: migration runs before Gateway wires the index. Remember an append-only merge so setTurnIndex
  // can reconcile an already-open index whose existing physical anchors must remain valid.
  private migrationAppendedRows = false;
  // C-40: a summary copy is durable pending work until the sink and the cleared window state both commit.
  private readonly pendingSummariesByChat: Map<string, string> = new Map();

  /** Wire compaction LLM calls through the semaphore at background priority (F8). */
  setBackgroundRunner(run: <T>(fn: () => Promise<T>) => Promise<T>): void {
    this.runBackground = run;
  }

  /** Wire the session_search FTS index for incremental per-turn indexing (D2.5). */
  setTurnIndex(index: SessionTurnIndexer): void {
    this.turnIndex = index;
    if (!this.migrationAppendedRows) return;
    try {
      if (index.reconcileFromDayFiles) {
        index.reconcileFromDayFiles();
      } else {
        // A non-rebuilding test/adapter can still arrange reconciliation on its next construction.
        index.markDirty?.();
      }
      this.migrationAppendedRows = false;
    } catch (e) {
      index.markDirty?.();
      console.warn('[session] migration index reconciliation failed; continuing:', summarizeErrorForLog(e));
    }
  }

  // D3.4/C-29: the sink that copies each compaction summary (anchored bullets) to the chat-scoped
  // session-summary lane. Wired by the Gateway through the WriteQueue. Optional and best-effort — a sink
  // failure never fails compaction.
  private summarySink?: (chatId: string, anchoredSummary: string) => Promise<void>;

  /** Wire the compaction-summary → chat-scoped sink (D3.4 / C-29). */
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

  /** Whether the constructor completed the legacy-session migration step. */
  get didCompleteLegacyMigration(): boolean {
    return this.legacyMigrationComplete;
  }

  /** The resolved day-file archive root — the Gateway builds the search index over this same directory. */
  get sessionsDir(): string {
    return this.sessionsPath;
  }

  /**
   * D4.4 (nightly-sweep seam): every chat's raw JSONL day-file lines for the UTC day of `date`.
   * Read-only + best-effort — the layout (per-chat subdir vs flat) matches the append path, a
   * missing/unreadable file contributes nothing, blank lines are dropped, and it never throws.
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
      // MEDIUM-5/F-14: readdir order is filesystem-defined; sort so the sweep's cross-chat ordering
      // and ≤5 selection are deterministic. `isDirectory()` reflects lstat, so a symlinked chat dir
      // (isSymbolicLink) is already excluded.
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
      // MEDIUM-1: reject a symlinked (or otherwise non-regular) day file — following it could read
      // another profile's transcript (cross-profile PHI) or block on a FIFO. HIGH-1: cap the read so
      // one pathologically large file can neither exhaust the heap nor block the loop unbounded.
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
    this.legacySessionsPath = opts.legacySessionsPath;
    secureMkdir(this.sessionsPath);
    this.legacyMigrationComplete = this.migrateLegacySessions(this.legacySessionsPath);
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
    // Three phases so the compaction LLM runs OFF the per-chat write queue (H2): a fast queued
    // evaluate+prune, then (for compact/emergency) the pipeline whose LLM is off-queue and whose apply
    // re-enters the queue (A-MF3 live tail), then a fast queued read of the resulting window.
    const trigger = await this.enqueue(chatId, async () => {
      const session = this.sessions.get(chatId);
      if (!session) return 'none' as WindowTrigger;
      // P2b/D1.4 (DD10): the perpetual thread NEVER idle-resets. spec 14 §3 real-token triggers replace
      // the old chars/4 heuristic: the last window-fill reading maps to prune / compact / emergency.
      const t = this.evaluateWindowTrigger(chatId);
      if (t !== 'none') {
        // A-MF3: consume the reading so the SAME stale value cannot re-fire the trigger every turn (the
        // reading only changes on the next recordPromptUsage).
        const reading = this.lastPromptTokensByChat.get(chatId);
        if (reading) reading.triggered = true;
        if (t === 'prune') {
          // ≥35%, no LLM — synchronous in this queued op (lossless; day file untouched).
          session.history = pruneToolResults(session.history, PRUNE_LAST_TURNS);
          this.saveWindowFor(chatId);
        }
      }
      return t;
    });

    if (trigger === 'compact') {
      // ≥50% — LLM pipeline in the BACKGROUND (off-queue LLM; queued live-tail apply). Return the
      // current (possibly over-budget) window now; the compacted one lands on a later turn.
      this.startBackgroundCompaction(chatId);
    } else if (trigger === 'emergency') {
      // ≥80% — reduce BEFORE the turn proceeds (awaited). A-M3: always runs, even enabled:false.
      await this.runEmergencyCompaction(chatId);
    }

    // DD2: the returned history IS the window — the summary system message (if any) followed by the
    // verbatim tail — sanitized so this boundary never emits an OpenAI-rejectable history (#16).
    return this.enqueue(chatId, async () =>
      stripOrphanToolMessages([...(this.sessions.get(chatId)?.history ?? [])]),
    );
  }

  // spec 14 §3: map the current window-fill reading to a trigger. A reading already consumed this cycle
  // (`triggered`) yields 'none' so the same stale value never re-fires (A-MF3).
  private evaluateWindowTrigger(chatId: string): WindowTrigger {
    const reading = this.lastPromptTokensByChat.get(chatId);
    if (!reading || reading.triggered) return 'none';
    return windowTriggerFor(this.windowFillPercent(chatId), this.windowThresholds());
  }

  // A-MF3 / H1: run at most ONE compaction pipeline per chat at a time. A concurrent trigger (a second
  // ≥50%, or an ≥80% emergency arriving during a ≥50% compact) reuses the SAME in-flight promise instead
  // of starting a second LLM pipeline. The LLM runs OFF the write queue (H2); only the snapshot + apply
  // re-enter it. Never rejects out (best-effort).
  private guardedCompaction(chatId: string): Promise<void> {
    const existing = this.compactionInFlight.get(chatId);
    if (existing) return existing;
    const p = this.doCompaction(chatId)
      .catch((e) => console.warn(`[session:${chatId}] compaction failed:`, summarizeErrorForLog(e)))
      .finally(() => this.compactionInFlight.delete(chatId));
    this.compactionInFlight.set(chatId, p);
    return p;
  }

  // ≥50% background compaction (fire-and-forget). M1: honors compaction.enabled=false (no proactive
  // compaction when disabled — the ≥80% emergency valve still protects against overflow).
  private startBackgroundCompaction(chatId: string): void {
    if (this.compactionConfig?.enabled === false) return;
    void this.guardedCompaction(chatId);
  }

  // ≥80% emergency (awaited before the turn). When enabled + an LLM is available, summarize (reusing an
  // in-flight pipeline, never a 2nd — H1). Then GUARANTEE the window is within budget with a no-LLM
  // turn-aware truncate that preserves a leading summary (A-M3 escape valve + M4) — idempotent, a no-op
  // when a just-applied compaction already brought the window to target.
  private async runEmergencyCompaction(chatId: string): Promise<void> {
    if (this.compactionConfig?.enabled !== false && this.llmProvider) {
      await this.guardedCompaction(chatId);
    }
    await this.enqueue(chatId, async () => {
      this.emergencyTruncate(chatId);
      this.saveWindowFor(chatId);
    });
  }

  // A-M3 / M4 overflow valve: reduce the in-memory window to a leading summary (preserved as metadata)
  // plus the last `keepRecentTurns` turns. No LLM; swaps in memory REGARDLESS of window-save success
  // (the caller persists best-effort) so an ≥80% emergency can never leave the window over budget.
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

  // Await EVERY in-flight background compaction (graceful shutdown): a fire-and-forget pipeline must not
  // write the window / summary sink after the store closes, nor outlive the process. Never rejects.
  async drainCompactions(): Promise<void> {
    await Promise.all([...this.compactionInFlight.values()].map((p) => p.catch(() => undefined)));
  }

  async recordTurn(chatId: string, turnTrace: Message[], origin: JsonlOrigin = 'chat'): Promise<Anchor[]> {
    return this.enqueue(chatId, async () => {
      if (turnTrace.length === 0) {
        return [];
      }
      // Persist-first: append to the JSONL BEFORE mutating in-memory state.
      // If the append/rotation throws, the enqueue promise rejects and the
      // in-memory session.history never sees the turn — no memory/disk
      // divergence. `origin` (A-H1) is stamped so the nightly sweep can trust
      // provenance instead of guessing from the text (heartbeat turns are daemon-authored).
      const anchors = await this.appendMessagesToJsonl(chatId, turnTrace, origin);
      const session = this.getOrCreateSessionState(chatId);
      session.history.push(...turnTrace);
      session.historyAnchors.push(...anchors);
      if (origin === 'chat') {
        this.chatsWithUserActivity.add(chatId);
        session.lastActiveAt = new Date();
      }
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
        : { tokens: estimateTokens(this.sessions.get(chatId)?.history ?? []) + FALLBACK_SYSTEM_OVERHEAD_TOKENS, estimated: true };
      this.lastPromptTokensByChat.set(chatId, reading);
      this.saveWindowFor(chatId);
    });
  }

  /**
   * DD9 `/new`: publish an empty EOF window before clearing in-memory state. The append-only day-file
   * archive is UNTOUCHED (DD1), so the disk log continues with contiguous line numbers and stays
   * searchable via session_search. A failed replacement write rejects the reset and leaves the old state
   * in place; callers must not report a successful reset after that failure.
   */
  async resetSession(chatId: string): Promise<void> {
    await this.enqueue(chatId, async () => {
      const pendingSummary = this.pendingSummariesByChat.get(chatId);
      const replacement: SessionWindow = {
        summaryBlock: '',
        verbatimFrom: latestDayFileEof(this.archiveDir(chatId)),
        ...(pendingSummary ? { pendingSummary } : {}),
      };
      // Persist the replacement first. The old window remains authoritative until this atomic write
      // succeeds, so a crash or unlink failure cannot resurrect pre-/new context.
      saveWindow(this.windowPath(chatId), replacement);
      this.sessions.delete(chatId);
      this.chatsWithUserActivity.delete(chatId);
      this.lastPromptTokensByChat.delete(chatId);
      if (!pendingSummary) this.pendingSummariesByChat.delete(chatId);
    });
  }

  // Public compaction (the /compact command + tests). With an LLM: the full §4 pipeline (off-queue LLM,
  // queued live-tail apply), reusing an in-flight one. Without an LLM: a synchronous turn-aware truncate.
  async runCompaction(chatId: string): Promise<void> {
    await this.retryPendingSummaries();
    if (this.llmProvider) {
      await this.guardedCompaction(chatId);
    } else {
      await this.enqueue(chatId, async () => this.noLlmCompact(chatId));
    }
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

  // No-LLM compaction (no provider): a synchronous turn-aware truncate (M4 preserves a leading summary),
  // candidate-then-swap so a failed window save keeps the old window (M5 / spec §4). Runs inside a queued op.
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
      return; // M5: window save failed → keep the old window
    }
    session.history = candidate;
    session.historyAnchors = candidateAnchors;
  }

  // §4 pipeline as three parts so the LLM runs OFF the write queue (H2):
  //   1. snapshot (queued read) → 2. flush + summary LLM (off-queue) → 3. apply (queued, live-tail).
  private async doCompaction(chatId: string): Promise<void> {
    const snap = await this.enqueue(chatId, async () => this.captureCompactionSnapshot(chatId));
    if (!snap) return; // nothing older to summarize (H3: never re-summarizes a lone leading summary)
    const built = await this.buildCompactionSummary(chatId, snap);
    if (!built) return; // flush/summary failed or empty ⇒ keep the OLD window (H6 / spec §4)
    await this.enqueue(chatId, async () => this.applyCompaction(chatId, snap, built));
  }

  // §4.1/4.2 snapshot: the real older messages to summarize (EXCLUDING any leading summary — H3), the
  // preserved prior-summary text, and the day-file anchors for the older range. null ⇒ nothing to do.
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
    const olderReal = history.slice(hasSummary ? 1 : 0, split); // exclude the leading summary (H3)
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

  // §4 flush + summary, run OFF the write queue. H6: a flush failure is a failed step ⇒ return null (keep
  // the old window), never fall through to a summary. H3: the prior summary is preserved verbatim and the
  // new bullets are appended. M3: model-supplied anchors are stripped before app-supplied ones are added.
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
        // H6 / spec §4: the flush is a pipeline STEP — its failure keeps the old window (do NOT summarize).
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
      // M3: strip any model-fabricated anchor, then attach app-supplied in-range anchors.
      const newBullets = anchorSummaryBullets(stripModelAnchors(summaryText), snap.rangeAnchors);
      // H3: preserve the prior summary verbatim (its facts + anchors), append the new bullets.
      const combinedSummary = snap.oldSummary ? `${snap.oldSummary}\n${newBullets}` : newBullets;
      return { combinedSummary, newBullets };
    } catch (e) {
      // spec §4: any step failing ⇒ keep the OLD window, retry next trigger. Sanitized frame only (PHI).
      console.warn(`[session:${chatId}] Compact turn failed (keeping current window):`, summarizeErrorForLog(e));
      return null;
    }
  }

  // §4.3 apply against the LIVE tail (A-MF3): if the history array was replaced since the snapshot
  // (emergency truncate / prune / reset), abort — the reduction already happened another way. M5:
  // persist the candidate window FIRST; swap in memory only on success. Then copy the NEW bullets to the
  // daily log (best-effort, idempotent — never the preserved old summary, so no double-logging — H3).
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
      return; // M5: window save failed → keep the old window (spec §4)
    }
    session.history = candidate;
    session.historyAnchors = candidateAnchors;
    this.pendingSummariesByChat.set(chatId, built.newBullets);
    if (this.summarySink) {
      await this.flushPendingSummaryLocked(chatId);
    }
  }

  // M5: persist a candidate window (summary + a verbatim tail) WITHOUT mutating in-memory state. The
  // candidate carries physical anchors for every retained message, so malformed archive slots do not
  // shift its cursor. Returns true on a successful save, false (keep old window) on failure.
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
    // H11 (defensive): secureAppend has no fsync, so a power-loss / external truncation can leave the
    // day file without a trailing newline. A raw append would FUSE the new record onto the torn line,
    // making one malformed physical line — the new (health) turn would vanish from resume + rebuild.
    // Insert a separating newline so the new record always starts its own physical line.
    const block = (dayFileEndsWithoutNewline(dayFilePath) ? '\n' : '') + lines.join('\n') + '\n';
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
      for (let i = 0; i < messages.length; i++) {
        const content = messages[i].content;
        if (typeof content !== 'string' || content.length === 0) continue;
        try {
          this.turnIndex.indexTurn(chatId, anchors[i].file, anchors[i].line, messages[i].role, now, content);
        } catch (e) {
          // H5: per-line guard — one line's index failure must not skip its siblings. Mark the index
          // dirty so the next boot reconciles the hole from the archive. Never blocks the turn.
          console.warn(`[session:${chatId}] turn indexing failed, continuing:`, summarizeErrorForLog(e));
          this.turnIndex.markDirty?.();
        }
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
    // A-H1/C-56: every current entry carries explicit provenance. Read-back remains tolerant of
    // origin-less legacy lines, but the marker heuristic is now legacy-only.
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

  // D1.5/A-MF5: the per-chat window state file. Registry mode = one per-profile window; no-registry
  // mode = per-chat so distinct ad-hoc chats never share a window (N-2). Lives inside sessionsPath
  // (test-isolated; the day-file scan ignores it — it is not a `YYYY-MM-DD.jsonl`).
  private windowPath(chatId: string): string {
    const resolved = this.perChatArchive
      ? resolveContainedPath(this.sessionsPath, `session-window.${chatId}.json`)
      : resolveContainedPath(this.sessionsPath, 'session-window.json');
    this.assertRegularFileIfPresent(resolved);
    return resolved;
  }

  // D1.5/A-MF5: the day-file archive directory for `chatId` — flat per profile (registry) or namespaced
  // per chat (no-registry). Mirrors `dayFilePath`.
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
    const verbatimFrom = realTailLength > 0 && firstAnchor
      ? anchorBefore(firstAnchor)
      : walkBackAnchor(this.archiveDir(chatId), realTailLength);
    const window: SessionWindow = { summaryBlock, verbatimFrom };
    if (pendingSummary) window.pendingSummary = pendingSummary;
    // DD3: carry the last window-fill reading so a restart resumes the trigger signal (A3).
    const usage = this.lastPromptTokensByChat.get(chatId);
    if (usage) {
      window.lastPromptTokens = usage.tokens;
      window.lastPromptTokensEstimated = usage.estimated;
    }
    return window;
  }

  // D1.5: the window as a DERIVED snapshot of in-memory history + physical archive anchors. A malformed
  // physical slot is absent from history but remains represented by the valid messages' carried cursors.
  private deriveWindow(chatId: string): SessionWindow {
    const session = this.sessions.get(chatId);
    return this.windowForHistory(
      chatId,
      session?.history ?? [],
      session?.historyAnchors ?? [],
      this.pendingSummariesByChat.get(chatId),
    );
  }

  // D1.5: persist the window snapshot (best-effort — a save failure must never break the turn, per
  // resilience.md; the archive on disk remains the source of truth).
  private saveWindowFor(chatId: string): boolean {
    try {
      saveWindow(this.windowPath(chatId), this.deriveWindow(chatId));
      return true;
    } catch (e) {
      console.warn(`[session:${chatId}] window state save failed, continuing:`, summarizeErrorForLog(e));
      return false;
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
        continue; // malformed physical slot — skip when reconstructing (A-H2)
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

  // D1.6/A-MF2: one-time migration of legacy `active-<chatId>.jsonl` files into the append-only day-file
  // archive, sentinel-gated by `<sessionsPath>/.migrated`. Each day file is built ATOMICALLY (tmp+rename)
  // and WRITE-IF-ABSENT (never a blind overwrite), so a retry after a crash — or after live turns already
  // appended to today's day file — can never destroy live-recorded data (N-1). Registry mode pools all
  // sources into shared root day files; no-registry mode buckets each source into its own `<chatId>/`
  // subdir (A-MF5/N-3). Best-effort: any failure logs sanitized and leaves the sentinel UNWRITTEN so the
  // migration retries next boot; the daemon never crashes.
  private migrateLegacySessions(sourcePath: string = this.sessionsPath): boolean {
    const sentinel = path.join(this.sessionsPath, '.migrated');
    const externalSource = path.resolve(sourcePath) !== path.resolve(this.sessionsPath);
    try {
      if (isValidSessionMigrationSentinel(sentinel) && !externalSource) return true;
      let legacy: string[];
      try {
        legacy = fs.readdirSync(sourcePath).filter((f) => f.startsWith('active-') && f.endsWith('.jsonl'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          if (!isValidSessionMigrationSentinel(sentinel)) this.writeSessionMigrationSentinel(sentinel);
          return isValidSessionMigrationSentinel(sentinel);
        }
        throw error;
      }
      if (legacy.length === 0) {
        if (!isValidSessionMigrationSentinel(sentinel)) this.writeSessionMigrationSentinel(sentinel);
        return isValidSessionMigrationSentinel(sentinel);
      }

      // Parse every legacy entry, preserving source-file order (sorted) then in-file order — the tie-break
      // for entries sharing a timestamp. Malformed / invalid-timestamp lines are skipped with a sanitized
      // (content-free) warn.
      interface Row { chatId: string; day: string; ts: number; order: number; raw: string }
      const rows: Row[] = [];
      let order = 0;
      for (const file of legacy.sort()) {
        const chatId = file.replace(/^active-/, '').replace(/\.jsonl$/, '');
        const sourceFile = resolveContainedPath(sourcePath, file);
        if (!fs.lstatSync(sourceFile).isFile()) {
          throw new Error('legacy session source is not a regular file');
        }
        const lines = fs.readFileSync(sourceFile, 'utf-8').split('\n').filter((l) => l.length > 0);
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
        const targetDir = this.perChatArchive
          ? resolveContainedPath(this.sessionsPath, r.chatId)
          : this.sessionsPath;
        const key = `${targetDir} ${r.day}`;
        (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(r);
      }
      const archiveDirs = new Set<string>();
      for (const [key, arr] of buckets) {
        const sep = key.indexOf(' ');
        const targetDir = key.slice(0, sep);
        const day = key.slice(sep + 1);
        arr.sort((x, y) => x.ts - y.ts || x.order - y.order); // Array.sort is stable ⇒ ties keep source order
        const dayPath = this.perChatArchive
          ? resolveContainedPath(this.sessionsPath, path.basename(targetDir), `${day}.jsonl`)
          : resolveContainedPath(this.sessionsPath, `${day}.jsonl`);
        this.assertRegularFileIfPresent(dayPath);
        const legacyRaws = arr.map((r) => r.raw);
        if (!fs.existsSync(dayPath)) {
          secureMkdir(targetDir);
          secureWriteViaTmp(dayPath, legacyRaws.join('\n') + '\n');
        } else {
          // F-3/C-12: the target day file already exists — a live turn was appended to it after a PRIOR
          // failed migration (sentinel absent). A blind skip would LOSE every legacy row for this day.
          // Append only legacy lines not already present (dedup by exact serialized line ⇒ idempotent on
          // re-run). Never reorder or rewrite existing bytes: physical #L<n> anchors are immutable.
          const existing = fs.readFileSync(dayPath, 'utf-8').split('\n').filter((l) => l.length > 0);
          const existingSet = new Set(existing);
          const additions = legacyRaws.filter((r) => !existingSet.has(r));
          if (additions.length > 0) {
            const separator = dayFileEndsWithoutNewline(dayPath) ? '\n' : '';
            secureAppend(dayPath, `${separator}${additions.join('\n')}\n`);
            this.migrationAppendedRows = true;
          }
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

      if (!isValidSessionMigrationSentinel(sentinel)) this.writeSessionMigrationSentinel(sentinel); // LAST — commits the migration
      return isValidSessionMigrationSentinel(sentinel);
    } catch (e) {
      // Boot-failure policy (A-MF2): warn sanitized, sentinel left UNWRITTEN (retry next boot), never crash.
      console.warn('[session] legacy migration failed, will retry next boot:', summarizeErrorForLog(e));
      return false;
    }
  }

  private seedWindowIfAbsent(windowPath: string, archiveDir: string, keepRecent: number): void {
    if (fs.existsSync(windowPath)) return;
    saveWindow(windowPath, { summaryBlock: '', verbatimFrom: walkBackAnchor(archiveDir, keepRecent) });
  }

  private writeSessionMigrationSentinel(sentinelPath: string): void {
    const payload: SessionMigrationSentinel = {
      version: 1,
      completed: true,
      completedAt: new Date().toISOString(),
    };
    secureWriteViaTmp(sentinelPath, JSON.stringify(payload));
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
