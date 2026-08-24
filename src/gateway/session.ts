import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message, ToolSchema } from '../providers/types';
import type { LLMProvider, LLMResponse } from '../providers/types';
import type { ToolRegistry } from '../tools/registry';
import { rotateFileIfNeeded, type RotationConfig } from '../scheduler/rotation';
import { summarizeErrorForLog, secureMkdir, secureWrite, secureWriteViaTmp, secureAppend, tightenFile } from '../security';

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

type ArchiveReason = 'manual-reset' | 'idle-hard-reset';

const ROTATION_CHECK_INTERVAL = 100;

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

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private softResetMs: number;
  private hardResetMs: number;
  private sessionsPath: string;
  private operationQueues: Map<string, Array<() => Promise<void>>> = new Map();
  private readonly llmProvider?: LLMProvider;
  private readonly toolRegistry?: ToolRegistry;
  private readonly compactionConfig?: CompactionConfig;
  private readonly rotationCounts: Map<string, number> = new Map();
  // F8: compaction LLM calls run at 'background' semaphore priority so they never starve or collide
  // with user turns. Injected by the Gateway (setter — the semaphore is created alongside). When
  // unset (tests / no semaphore), the call runs directly. prepareHistory always runs BEFORE the
  // AgentLoop acquires the semaphore, so this background acquire cannot self-deadlock (v2-H-4).
  private runBackground?: <T>(fn: () => Promise<T>) => Promise<T>;

  /** Wire compaction LLM calls through the semaphore at background priority (F8). */
  setBackgroundRunner(run: <T>(fn: () => Promise<T>) => Promise<T>): void {
    this.runBackground = run;
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

  constructor(
    softResetMinutes: number,
    hardResetMinutes: number,
    sessionsPath?: string,
    llmProvider?: LLMProvider,
    toolRegistry?: ToolRegistry,
    compactionConfig?: CompactionConfig,
    private readonly profileId: string = 'default',
    private readonly rotationConfig?: Partial<RotationConfig>,
  ) {
    this.softResetMs = softResetMinutes * 60 * 1000;
    this.hardResetMs = hardResetMinutes * 60 * 1000;
    this.sessionsPath = sessionsPath ?? path.join(os.homedir(), '.redacted', 'sessions');
    this.llmProvider = llmProvider;
    this.toolRegistry = toolRegistry;
    this.compactionConfig = compactionConfig;
    secureMkdir(this.sessionsPath);
    this.loadActiveSessions();
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

      const idleMs = Date.now() - session.lastActiveAt.getTime();
      if (idleMs > this.hardResetMs) {
        console.log(`[session:${chatId}] Hard reset after ${Math.round(idleMs / 60000)}m idle`);
        await this.archiveSessionInternal(chatId, 'idle-hard-reset');
        return [];
      }

      if (idleMs > this.softResetMs && this.compactionConfig?.enabled !== false) {
        console.log(`[session:${chatId}] Soft reset after ${Math.round(idleMs / 60000)}m idle`);
        await this.runCompactionInternal(chatId);
        session.lastActiveAt = new Date();
      } else if (
        this.compactionConfig?.enabled !== false &&
        this.exceedsTokenBudget(session.history) &&
        this.canReduceByCompaction(session.history)
      ) {
        // #15: token-budget trigger for actively-growing (non-idle) sessions —
        // compact before the running history overflows the model's context
        // window, not only on idle. Guarded by canReduceByCompaction (F2) so an
        // unshrinkable over-budget history does not rewrite itself every turn.
        console.log(
          `[session:${chatId}] Token-budget compaction (~${estimateTokens(session.history)} est. tokens)`,
        );
        await this.runCompactionInternal(chatId);
      }

      return [...(this.sessions.get(chatId)?.history ?? [])];
    });
  }

  async recordTurn(chatId: string, turnTrace: Message[]): Promise<void> {
    await this.enqueue(chatId, async () => {
      if (turnTrace.length === 0) {
        return;
      }
      // Persist-first: append to the JSONL BEFORE mutating in-memory state.
      // If the append/rotation throws, the enqueue promise rejects and the
      // in-memory session.history never sees the turn — no memory/disk
      // divergence.
      await this.appendMessagesToJsonl(chatId, turnTrace);
      const session = this.getOrCreateSessionState(chatId);
      session.history.push(...turnTrace);
      session.lastActiveAt = new Date();
      this.sessions.set(chatId, session);
    });
  }

  async addTurn(chatId: string, userMsg: Message, assistantMsg: Message): Promise<void> {
    await this.recordTurn(chatId, [userMsg, assistantMsg]);
  }

  async resetSession(chatId: string): Promise<void> {
    await this.enqueue(chatId, async () => {
      await this.archiveSessionInternal(chatId, 'manual-reset');
    });
  }

  async runCompaction(chatId: string): Promise<void> {
    await this.enqueue(chatId, async () => {
      await this.runCompactionInternal(chatId);
    });
  }

  // #15: cheap token-budget check. Rough by design (see estimateTokens) — a
  // safety-margin trigger, not exact accounting. Never throws out (a check
  // failure must not break message handling — resilience.md).
  private exceedsTokenBudget(history: Message[]): boolean {
    try {
      const pct = this.compactionConfig?.triggerAtTokenPercent;
      if (!pct || pct <= 0) return false;
      const budget = (pct / 100) * contextWindowFor(this.llmProvider?.modelName);
      return estimateTokens(history) > budget;
    } catch (e) {
      console.warn('[session] token-budget check failed, skipping token trigger:', summarizeErrorForLog(e));
      return false;
    }
  }

  // #15 (F2): a token-budget over-limit history is only worth compacting when a
  // shrink is actually possible. On an unshrinkable history (e.g. a single
  // message larger than the whole budget) computeCleanSplit is 0 → olderTurns
  // empty → compaction would rewrite the identical history on every turn
  // forever. Skip the token trigger in that case.
  private canReduceByCompaction(history: Message[]): boolean {
    const keepRecent = Math.max(1, this.compactionConfig?.keepRecentTurns ?? 10);
    return computeCleanSplit(history, keepRecent) > 0;
  }

  private async runCompactionInternal(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;

    const keepRecent = Math.max(1, this.compactionConfig?.keepRecentTurns ?? 10);
    const doFlush = this.compactionConfig?.memoryFlush ?? true;

    if (!this.llmProvider) {
      // #16: snap the boundary so we never start the kept slice on an orphan
      // `tool` message, then sanitize as belt-and-braces.
      const split = computeCleanSplit(session.history, keepRecent);
      const newHistory = stripOrphanToolMessages(session.history.slice(split));
      // Atomicity (RES-P1-2): persist FIRST; only mutate session.history once
      // the on-disk write committed. Degrade like the summary path (F6): a
      // persist failure must warn-and-continue, never reject the turn — leave
      // the in-memory history untouched.
      try {
        await this.persistHistory(chatId, newHistory);
        session.history = newHistory;
      } catch (e) {
        console.warn('[session] no-LLM compaction persist failed; history left unchanged:', summarizeErrorForLog(e));
      }
      return;
    }

    // #16: split on a CLEAN boundary (never mid tool-call group) so recentTurns
    // does not start with a dangling `tool` and olderTurns does not end with an
    // unmatched assistant+tool_calls.
    const split = computeCleanSplit(session.history, keepRecent);
    const recentTurns = session.history.slice(split);
    const olderTurns = session.history.slice(0, split);

    if (olderTurns.length === 0) {
      const cleaned = stripOrphanToolMessages(recentTurns);
      // F6: degrade on persist failure (matches the summary-path fallback).
      try {
        await this.persistHistory(chatId, cleaned);
        session.history = cleaned;
      } catch (e) {
        console.warn('[session] compaction persist (no older turns) failed; history left unchanged:', summarizeErrorForLog(e));
      }
      return;
    }

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
      const assembled: Message[] = summaryText
        ? [
          { role: 'system', content: `[Previous conversation summary]\n${summaryText}` },
          ...recentTurns,
        ]
        : recentTurns;
      // #16: sanitize the assembled history before it becomes the new session
      // history (belt-and-braces after the clean split).
      const newHistory = stripOrphanToolMessages(assembled);
      // Persist FIRST, assign on success (RES-P1-2 atomicity).
      await this.persistHistory(chatId, newHistory);
      session.history = newHistory;
    } catch (e) {
      // Provider error messages can echo transcript PHI — sanitized frame only.
      console.warn('[session] Compact turn failed:', summarizeErrorForLog(e));
      // Fallback: keep the recent turns. Persist FIRST, then assign — so a
      // crash during this fallback cannot leave in-memory state diverged from
      // disk. If even this persist fails, leave session.history unchanged and
      // log sanitized; the caller keeps the pre-compaction history.
      try {
        const cleaned = stripOrphanToolMessages(recentTurns);
        await this.persistHistory(chatId, cleaned);
        session.history = cleaned;
      } catch (persistError) {
        console.warn(
          '[session] Fallback persist after failed compaction also failed; in-memory history left unchanged:',
          summarizeErrorForLog(persistError),
        );
      }
    }
  }

  private async archiveSessionInternal(chatId: string, reason: ArchiveReason): Promise<void> {
    const activePath = this.activePath(chatId);
    const session = this.sessions.get(chatId);
    const hasActiveFile = fs.existsSync(activePath);

    if (!hasActiveFile && !session) {
      this.sessions.delete(chatId);
      return;
    }

    const { history } = hasActiveFile
      ? this.readHistoryFromJsonl(activePath)
      : { history: session?.history ?? [] };

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const stamp = Date.now();
    const archiveDir = path.join(this.sessionsPath, 'archive');
    const summariesDir = path.join(this.sessionsPath, 'summaries');
    secureMkdir(archiveDir);
    secureMkdir(summariesDir);

    const archivePath = path.join(archiveDir, `${dateStr}-${chatId}-${stamp}.jsonl`);
    const summaryPath = path.join(summariesDir, `${dateStr}-${chatId}-${stamp}.md`);

    if (hasActiveFile) {
      fs.renameSync(activePath, archivePath);
      // rename preserves mode; tighten in case the active file was loose.
      tightenFile(archivePath);
    } else {
      const lines = history.map(msg => JSON.stringify(this.serializeEntry(chatId, msg, now.toISOString())));
      secureWrite(archivePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
    }

    const summaryContent = await this.generateSummary(chatId, history, reason, now);
    secureWrite(summaryPath, summaryContent);

    this.sessions.delete(chatId);
    console.log(`[session:${chatId}] Archived to ${archivePath}`);
  }

  private async generateSummary(
    chatId: string,
    history: Message[],
    reason: ArchiveReason,
    archivedAt: Date,
  ): Promise<string> {
    const dateStr = archivedAt.toISOString().split('T')[0];
    const reasonLabel = reason === 'manual-reset' ? '/new command' : 'idle hard reset';
    const header = `# Session Summary — ${dateStr}

Chat ID: ${chatId}
Archived: ${archivedAt.toISOString()}
Reason: ${reasonLabel}
Messages: ${history.length}`;

    const fallback = (details: string): string => `${header}

## Summary Generation Failed
${details}

The raw session transcript is archived in JSONL and can be reviewed directly.`;

    if (!this.llmProvider) {
      return fallback('No summarization provider configured.');
    }

    try {
      const response = await this.runLLMWithRetry<LLMResponse>('archive-summary', () => this.llmProvider!.chat([
        {
          role: 'system',
          content: `Produce a concise session summary.
You must preserve:
- health facts
- user preferences
- open questions
- follow-up actions
- notable report-analysis outcomes
Use short bullet points grouped by section.`,
        },
        {
          role: 'user',
          content: JSON.stringify(history),
        },
      ]));

      if (response.type !== 'text' || response.text.trim().length === 0) {
        return fallback('Provider returned no text summary.');
      }

      return `${header}

## Summary
${response.text.trim()}`;
    } catch (e) {
      // PHI: never persist raw error.message (it can echo transcript content).
      return fallback(`Provider call failed: ${summarizeErrorForLog(e)}`);
    }
  }

  private async persistHistory(chatId: string, history: Message[]): Promise<void> {
    const activePath = this.activePath(chatId);
    if (history.length === 0) {
      if (fs.existsSync(activePath)) {
        fs.unlinkSync(activePath);
      }
      return;
    }

    const now = new Date().toISOString();
    this.maybeRotate(chatId);
    const lines = history.map(msg => JSON.stringify(this.serializeEntry(chatId, msg, now)));
    // Atomic write (tmp+rename): a crash mid-compaction must NOT truncate the
    // on-disk JSONL to zero bytes (RES-P1-1). secureWriteViaTmp writes a tmp
    // file at 0o600 then renames over the target; the original stays intact
    // until rename succeeds.
    secureWriteViaTmp(activePath, lines.join('\n') + '\n');
  }

  private async appendMessagesToJsonl(chatId: string, messages: Message[]): Promise<void> {
    const now = new Date().toISOString();
    this.maybeRotate(chatId);
    const lines = messages.map(msg => JSON.stringify(this.serializeEntry(chatId, msg, now)));
    secureAppend(this.activePath(chatId), lines.join('\n') + '\n');
  }

  private maybeRotate(chatId: string): void {
    const count = (this.rotationCounts.get(chatId) ?? 0) + 1;
    this.rotationCounts.set(chatId, count);
    if (count !== 1 && count % ROTATION_CHECK_INTERVAL !== 0) {
      return;
    }
    try {
      rotateFileIfNeeded(this.activePath(chatId), this.rotationConfig);
    } catch (error) {
      console.warn(
        `[session:${chatId}] rotation check failed, continuing without rotation:`,
        summarizeErrorForLog(error),
      );
    }
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

  private readHistoryFromJsonl(filePath: string): { history: Message[]; lastTimestamp?: Date } {
    const history: Message[] = [];
    if (!fs.existsSync(filePath)) {
      return { history };
    }

    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (raw.length === 0) {
      return { history };
    }

    const lines = raw.split('\n').filter((l) => l.length > 0);
    let lastTimestamp: Date | undefined;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlEntry;
        const message = this.entryToMessage(entry);
        if (!message) {
          continue;
        }
        history.push(message);
        const parsedTs = new Date(entry.timestamp);
        if (!Number.isNaN(parsedTs.getTime())) {
          lastTimestamp = parsedTs;
        }
      } catch {
        console.warn(`[session] Failed to parse JSONL line in ${filePath}`);
      }
    }

    return { history, lastTimestamp };
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

  private activePath(chatId: string): string {
    return path.join(this.sessionsPath, `active-${chatId}.jsonl`);
  }

  private loadActiveSessions(): void {
    if (!fs.existsSync(this.sessionsPath)) return;

    const files = fs.readdirSync(this.sessionsPath).filter((f) => f.startsWith('active-') && f.endsWith('.jsonl'));

    for (const file of files) {
      const chatId = file.replace('active-', '').replace('.jsonl', '');
      const filePath = path.join(this.sessionsPath, file);
      const { history: rawHistory, lastTimestamp } = this.readHistoryFromJsonl(filePath);
      // A torn append (a lost final `tool` line) can leave an OpenAI-invalid
      // history on disk — a trailing assistant+tool_calls, or a leading orphan
      // tool. Sanitize BEFORE it enters the live session map, so the first turn
      // after restart is not a guaranteed provider 400. The #16 "never emit a
      // rejectable history" property must hold at EVERY boundary, not only
      // inside compaction. (Archiving still reads the raw file verbatim.)
      const history = stripOrphanToolMessages(rawHistory);
      if (history.length === 0) {
        continue;
      }

      this.sessions.set(chatId, {
        chatId,
        history,
        lastActiveAt: lastTimestamp ?? new Date(),
      });
    }

    if (files.length > 0) {
      console.log(`[session] Loaded ${files.length} active session(s) from disk`);
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
