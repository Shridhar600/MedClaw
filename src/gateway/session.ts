import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message, ToolSchema } from '../providers/types';
import type { LLMProvider } from '../providers/types';
import type { ToolRegistry } from '../tools/registry';

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

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private softResetMs: number;
  private hardResetMs: number;
  private sessionsPath: string;
  private operationQueues: Map<string, Promise<void>> = new Map();
  private readonly llmProvider?: LLMProvider;
  private readonly toolRegistry?: ToolRegistry;
  private readonly compactionConfig?: CompactionConfig;

  constructor(
    softResetMinutes: number,
    hardResetMinutes: number,
    sessionsPath?: string,
    llmProvider?: LLMProvider,
    toolRegistry?: ToolRegistry,
    compactionConfig?: CompactionConfig,
    private readonly profileId: string = 'default',
  ) {
    this.softResetMs = softResetMinutes * 60 * 1000;
    this.hardResetMs = hardResetMinutes * 60 * 1000;
    this.sessionsPath = sessionsPath ?? path.join(os.homedir(), '.redacted', 'sessions');
    this.llmProvider = llmProvider;
    this.toolRegistry = toolRegistry;
    this.compactionConfig = compactionConfig;
    fs.mkdirSync(this.sessionsPath, { recursive: true });
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
      }

      return [...(this.sessions.get(chatId)?.history ?? [])];
    });
  }

  async recordTurn(chatId: string, turnTrace: Message[]): Promise<void> {
    await this.enqueue(chatId, async () => {
      if (turnTrace.length === 0) {
        return;
      }
      const session = this.getOrCreateSessionState(chatId);
      session.history.push(...turnTrace);
      session.lastActiveAt = new Date();
      this.sessions.set(chatId, session);
      await this.appendMessagesToJsonl(chatId, turnTrace);
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

  private async runCompactionInternal(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;

    const keepRecent = Math.max(1, this.compactionConfig?.keepRecentTurns ?? 10);
    const doFlush = this.compactionConfig?.memoryFlush ?? true;

    if (!this.llmProvider) {
      session.history = session.history.slice(-keepRecent);
      await this.persistHistory(chatId, session.history);
      return;
    }

    const recentTurns = session.history.slice(-keepRecent);
    const olderTurns = session.history.slice(0, -keepRecent);

    if (olderTurns.length === 0) {
      session.history = recentTurns;
      await this.persistHistory(chatId, session.history);
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

        const flushResponse = await this.llmProvider.chat(
          [
            { role: 'system', content: flushPrompt },
            ...olderTurns,
            { role: 'user', content: 'Persist what should be remembered before compaction.' },
          ],
          toolSchemas,
        );

        if (flushResponse.type === 'tool_call') {
          await this.toolRegistry.execute(flushResponse.toolCall.name, flushResponse.toolCall.arguments);
        }
      } catch (e) {
        console.warn('[session] Flush turn failed:', e);
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
      const summaryResponse = await this.llmProvider.chat([
        { role: 'system', content: compactPrompt },
        { role: 'user', content: JSON.stringify(olderTurns) },
      ]);

      if (summaryResponse.type === 'text' && summaryResponse.text.trim().length > 0) {
        session.history = [
          { role: 'system', content: `[Previous conversation summary]\n${summaryResponse.text.trim()}` },
          ...recentTurns,
        ];
      } else {
        session.history = recentTurns;
      }

      await this.persistHistory(chatId, session.history);
    } catch (e) {
      console.warn('[session] Compact turn failed:', e);
      session.history = recentTurns;
      await this.persistHistory(chatId, session.history);
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
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(summariesDir, { recursive: true });

    const archivePath = path.join(archiveDir, `${dateStr}-${chatId}-${stamp}.jsonl`);
    const summaryPath = path.join(summariesDir, `${dateStr}-${chatId}-${stamp}.md`);

    if (hasActiveFile) {
      fs.renameSync(activePath, archivePath);
    } else {
      const lines = history.map(msg => JSON.stringify(this.serializeEntry(chatId, msg, now.toISOString())));
      fs.writeFileSync(archivePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
    }

    const summaryContent = await this.generateSummary(chatId, history, reason, now);
    fs.writeFileSync(summaryPath, summaryContent, 'utf-8');

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
      const response = await this.llmProvider.chat([
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
      ]);

      if (response.type !== 'text' || response.text.trim().length === 0) {
        return fallback('Provider returned no text summary.');
      }

      return `${header}

## Summary
${response.text.trim()}`;
    } catch (e) {
      return fallback(`Provider call failed: ${String(e)}`);
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
    const lines = history.map(msg => JSON.stringify(this.serializeEntry(chatId, msg, now)));
    fs.writeFileSync(activePath, lines.join('\n') + '\n', 'utf-8');
  }

  private async appendMessagesToJsonl(chatId: string, messages: Message[]): Promise<void> {
    const now = new Date().toISOString();
    const lines = messages.map(msg => JSON.stringify(this.serializeEntry(chatId, msg, now)));
    fs.appendFileSync(this.activePath(chatId), lines.join('\n') + '\n', 'utf-8');
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
      const { history, lastTimestamp } = this.readHistoryFromJsonl(filePath);
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
    const previous = this.operationQueues.get(chatId) ?? Promise.resolve();
    const nextOperation = previous.catch(() => undefined).then(operation);
    const settled = nextOperation.then(() => undefined, () => undefined);
    this.operationQueues.set(chatId, settled);

    return nextOperation.finally(() => {
      if (this.operationQueues.get(chatId) === settled) {
        this.operationQueues.delete(chatId);
      }
    });
  }
}
