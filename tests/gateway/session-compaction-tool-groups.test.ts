import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';
import {
  SessionManager,
  estimateTokens,
  contextWindowFor,
  stripOrphanToolMessages,
} from '../../src/gateway/session';

// -----------------------------------------------------------------------------
// #16: compaction must never split an assistant+tool_calls / tool group.
//
// On the OpenAI provider, a `tool` message with no immediately-preceding
// `assistant`+`tool_calls` (or a trailing `assistant`+`tool_calls` with no
// following tool result) is a hard 400:
//   "messages with role 'tool' must be a response to a preceding message with
//    'tool_calls'"
// This is masked on Ollama (lenient) and by text-only unit tests. These tests
// use a STRICT mock provider that mimics OpenAI's validation so the failure is
// reproducible in-process.
// -----------------------------------------------------------------------------

const OPENAI_TOOL_ORDERING_ERROR =
  "Invalid parameter: messages with role 'tool' must be a response to a preceding message with 'tool_calls'.";
const OPENAI_TRAILING_TOOLCALLS_ERROR =
  "Invalid: an assistant message with 'tool_calls' must be followed by tool response messages.";

/** Faithful (structural) reproduction of OpenAI's message-ordering validation. */
function validateOpenAIOrdering(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    // (1) Every `tool` message must trace back (through tool siblings) to an
    //     assistant with tool_calls.
    if (m.role === 'tool') {
      let j = i - 1;
      while (j >= 0 && messages[j].role === 'tool') j--;
      const parent = j >= 0 ? messages[j] : undefined;
      const hasToolCalls =
        !!parent &&
        parent.role === 'assistant' &&
        !!parent.tool_calls &&
        parent.tool_calls.length > 0;
      if (!hasToolCalls) {
        throw new Error(OPENAI_TOOL_ORDERING_ERROR);
      }
    }
    // (2) Every assistant with tool_calls must be IMMEDIATELY followed by a
    //     tool response — whether mid-sequence (flush failure) or trailing.
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const next = messages[i + 1];
      if (!next || next.role !== 'tool') {
        throw new Error(OPENAI_TRAILING_TOOLCALLS_ERROR);
      }
    }
  }
}

interface RecordedCall {
  messages: Message[];
  valid: boolean;
}

/**
 * Strict provider: records every chat() call and whether the messages were a
 * valid OpenAI sequence. Throws (like the real API) on an invalid sequence so
 * the session's own try/catch behaves as it would in production.
 */
function makeStrictProvider(
  summaryText: string,
  modelName?: string,
): LLMProvider & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const provider = {
    modelName,
    calls,
    chat: jest.fn(async (messages: Message[]): Promise<LLMResponse> => {
      let valid = true;
      try {
        validateOpenAIOrdering(messages);
      } catch (e) {
        valid = false;
        calls.push({ messages: messages.map((m) => ({ ...m })), valid });
        throw e;
      }
      calls.push({ messages: messages.map((m) => ({ ...m })), valid });
      return { type: 'text', text: summaryText };
    }),
    embed: jest.fn(async () => [0.1, 0.2, 0.3]),
  } as unknown as LLMProvider & { calls: RecordedCall[] };
  return provider;
}

/** Does any `tool` message lack a valid preceding assistant+tool_calls parent? */
function hasDanglingTool(messages: Message[]): boolean {
  try {
    // Reuse the strict check but only for the dangling-tool aspect.
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'tool') continue;
      let j = i - 1;
      while (j >= 0 && messages[j].role === 'tool') j--;
      const parent = j >= 0 ? messages[j] : undefined;
      const ok =
        !!parent &&
        parent.role === 'assistant' &&
        !!parent.tool_calls &&
        parent.tool_calls.length > 0;
      if (!ok) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function asstToolCall(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
  };
}

function toolResult(id: string, content: string): Message {
  return { role: 'tool', content, tool_call_id: id };
}

describe('Compaction never splits a tool-call group (#16)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-compaction-toolgroup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // Turn-aware compaction (H4) keeps the last keepRecentTurns TURNS, so we seed one older turn (to be
  // summarized away) plus the split-inducing tool-group turn in the RECENT tail. This still proves #16
  // (a compaction boundary never splits a tool group) and gives the flush a real older range.
  //   [older, olderA, u1, a1, u2, asst(tc), tool, a2]  (keepRecentTurns=2 -> recent = [u1..a2])
  async function seedSplitInducingHistory(manager: SessionManager, chatId: string): Promise<void> {
    await manager.recordTurn(chatId, [
      { role: 'user', content: 'older turn to summarize' },
      { role: 'assistant', content: 'older answer' },
    ]);
    await manager.recordTurn(chatId, [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
    await manager.recordTurn(chatId, [
      { role: 'user', content: 'u2 — check my labs' },
      asstToolCall('tc1', 'memory_read'),
      toolResult('tc1', 'glucose 300 on file'),
      { role: 'assistant', content: 'a2 final answer' },
    ]);
  }

  it('post-compaction history has no dangling tool at the head', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = makeStrictProvider('summary of older turns', 'gpt-5.6-luna');
    const manager = new SessionManager(240, 1440, tmpDir, provider, undefined, {
      enabled: true,
      triggerAtTokenPercent: 80,
      memoryFlush: false,
      keepRecentTurns: 2,
    });
    const chatId = 'chat-head';
    await seedSplitInducingHistory(manager, chatId);

    await manager.runCompaction(chatId);

    const history = manager.getHistory(chatId);
    expect(hasDanglingTool(history)).toBe(false);
    warnSpy.mockRestore();
  });

  it('the NEXT turn after compaction is a valid OpenAI sequence (no 400)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = makeStrictProvider('summary of older turns', 'gpt-5.6-luna');
    const manager = new SessionManager(240, 1440, tmpDir, provider, undefined, {
      enabled: true,
      triggerAtTokenPercent: 80,
      memoryFlush: false,
      keepRecentTurns: 2,
    });
    const chatId = 'chat-next';
    await seedSplitInducingHistory(manager, chatId);

    await manager.runCompaction(chatId);

    // Simulate the agent loop's next turn against the strict provider.
    const nextTurn: Message[] = [
      ...manager.getHistory(chatId),
      { role: 'user', content: 'and my blood pressure?' },
    ];
    await expect(provider.chat(nextTurn)).resolves.toBeDefined();
    warnSpy.mockRestore();
  });

  it('the memory-flush call receives a valid sequence (no trailing tool_calls)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = makeStrictProvider('summary of older turns', 'gpt-5.6-luna');
    const toolRegistry = {
      getAvailable: () => [
        {
          name: 'memory_write',
          description: 'write memory',
          group: 'group:memory',
          parameters: { properties: {}, required: [] },
        },
      ],
      execute: jest.fn(async () => 'ok'),
    } as unknown as import('../../src/tools/registry').ToolRegistry;

    const manager = new SessionManager(240, 1440, tmpDir, provider, toolRegistry, {
      enabled: true,
      triggerAtTokenPercent: 80,
      memoryFlush: true,
      keepRecentTurns: 2,
    });
    const chatId = 'chat-flush';
    await seedSplitInducingHistory(manager, chatId);

    await manager.runCompaction(chatId);

    // The flush call is the first chat() invocation (memoryFlush=true).
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls[0].valid).toBe(true);
    warnSpy.mockRestore();
  });

  it('the no-LLM compaction branch also produces a clean head', async () => {
    // No provider -> the slice(-keepRecent) fast path.
    const manager = new SessionManager(240, 1440, tmpDir, undefined, undefined, {
      enabled: true,
      triggerAtTokenPercent: 80,
      memoryFlush: false,
      keepRecentTurns: 2,
    });
    const chatId = 'chat-nollm';
    await seedSplitInducingHistory(manager, chatId);

    await manager.runCompaction(chatId);

    expect(hasDanglingTool(manager.getHistory(chatId))).toBe(false);
  });
});

describe('stripOrphanToolMessages (belt-and-braces sanitizer)', () => {
  it('drops a leading tool message with no parent', () => {
    const out = stripOrphanToolMessages([
      toolResult('x', 'orphan'),
      { role: 'user', content: 'hi' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user']);
  });

  it('drops an orphan tool that follows a plain assistant turn', () => {
    const out = stripOrphanToolMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      toolResult('x', 'orphan'),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('preserves a valid assistant+tool_calls / tool group', () => {
    const input: Message[] = [
      { role: 'user', content: 'hi' },
      asstToolCall('tc', 'memory_read'),
      toolResult('tc', 'result'),
      { role: 'assistant', content: 'done' },
    ];
    expect(stripOrphanToolMessages(input)).toEqual(input);
  });

  it('drops a trailing assistant+tool_calls with no tool result', () => {
    const out = stripOrphanToolMessages([
      { role: 'user', content: 'hi' },
      asstToolCall('tc', 'memory_read'),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user']);
  });
});

describe('Token-budget compaction trigger (#15)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-compaction-token-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('estimateTokens ~= chars/4', () => {
    expect(estimateTokens([{ role: 'user', content: '12345678' }])).toBe(2);
    expect(estimateTokens([])).toBe(0);
  });

  it('contextWindowFor maps known models, defaults to 8192', () => {
    expect(contextWindowFor('gpt-5.6-luna')).toBe(128000);
    expect(contextWindowFor('o1-preview')).toBe(128000);
    expect(contextWindowFor('gpt-4o')).toBe(128000);
    expect(contextWindowFor('gpt-4.1')).toBe(128000);
    expect(contextWindowFor('llama3.2:3b')).toBe(128000);
    expect(contextWindowFor('kimi-k2.5:cloud')).toBe(262144); // F5: shipped default model
    expect(contextWindowFor('medgemma')).toBe(8192);
    expect(contextWindowFor(undefined)).toBe(8192);
  });

  it('prepareHistory emergency-compacts an over-budget (≥80%) session synchronously (spec 14 §3)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    // model undefined -> 8192 context window. A real reading of 7000 tokens ~= 85% ⇒ emergency (sync).
    const provider = makeStrictProvider('compacted summary', undefined);
    const manager = new SessionManager(240, 1440, tmpDir, provider, undefined, {
      enabled: true,
      triggerAtTokenPercent: 80,
      memoryFlush: false,
      keepRecentTurns: 2,
    });
    const chatId = 'chat-overbudget';
    for (let i = 0; i < 8; i++) {
      await manager.recordTurn(chatId, [
        { role: 'user', content: `user message number ${i} with some padding text` },
        { role: 'assistant', content: `assistant reply number ${i} with some padding text` },
      ]);
    }
    const before = manager.getHistory(chatId).length;
    expect(before).toBe(16);
    await manager.recordPromptUsage(chatId, 7000); // ≥80% of the 8192 window → emergency

    const prepared = await manager.prepareHistory(chatId);

    expect(prepared.length).toBeLessThan(before);
    expect(prepared[0].role).toBe('system');
    expect(prepared[0].content).toContain('Previous conversation summary');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('prepareHistory does NOT compact an under-budget session', async () => {
    const provider = makeStrictProvider('should not be called', undefined);
    const manager = new SessionManager(240, 1440, tmpDir, provider, undefined, {
      enabled: true,
      triggerAtTokenPercent: 80, // legacy key, inert under spec-14 window triggers
      memoryFlush: false,
      keepRecentTurns: 2,
    });
    const chatId = 'chat-underbudget';
    await manager.recordTurn(chatId, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    // A REAL under-threshold reading (~0.1% of the 8192 default window) — proves the trigger is off
    // because the fill is low, NOT merely because no reading was ever recorded (test-integrity fix).
    await manager.recordPromptUsage(chatId, 10);

    const prepared = await manager.prepareHistory(chatId);

    expect(prepared.length).toBe(2);
    expect((provider.chat as jest.Mock)).not.toHaveBeenCalled();
  });

  // F2: an over-budget history that cannot shrink (single message larger than
  // the budget) must NOT fire compaction on every turn — no rewrite-loop.
  it('does not fire the token trigger when no older turns can be split off', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = makeStrictProvider('summary', undefined); // 8192 window
    const manager = new SessionManager(240, 1440, tmpDir, provider, undefined, {
      enabled: true,
      triggerAtTokenPercent: 10, // budget ~819 tokens ~3276 chars
      memoryFlush: false,
      keepRecentTurns: 2,
    });
    const chatId = 'chat-wedge';
    await manager.recordTurn(chatId, [{ role: 'user', content: 'x'.repeat(5000) }]);

    await manager.prepareHistory(chatId);
    await manager.prepareHistory(chatId);

    const tokenLogs = logSpy.mock.calls.filter((c) => String(c[0]).includes('Token-budget compaction'));
    expect(tokenLogs.length).toBe(0);
    expect(manager.getHistory(chatId).length).toBe(1);
  });
});

// The raw CJS fs module — spyable, unlike the ts-jest __importStar clone.
const fsRealForFixes = jest.requireActual<typeof import('fs')>('fs');

// F1: a torn append can leave an OpenAI-invalid history on disk (a trailing
// assistant+tool_calls whose tool result line was lost). Reload must sanitize
// it before it enters the live session map, or the first turn after restart
// 400s and the session is dead until idle-reset/`/new`.
describe('Reload sanitizes an OpenAI-invalid persisted history (F1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-reload-sanitize-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('drops a trailing orphan assistant+tool_calls left by a torn append', async () => {
    const chatId = 'chat-torn';
    const jsonlPath = path.join(tmpDir, `active-${chatId}.jsonl`);
    const ts = new Date().toISOString();
    const lines =
      [
        { timestamp: ts, role: 'user', content: 'u1', chatId },
        {
          timestamp: ts,
          role: 'assistant',
          content: null,
          chatId,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'memory_read', arguments: '{}' } }],
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    fs.writeFileSync(jsonlPath, lines);

    const provider = makeStrictProvider('summary', 'gpt-5.6-luna');
    const manager = new SessionManager(240, 1440, tmpDir, provider, undefined, {
      enabled: true,
      triggerAtTokenPercent: 80,
      memoryFlush: false,
      keepRecentTurns: 10,
    });

    const history = manager.getHistory(chatId);
    const last = history[history.length - 1];
    expect(Boolean(last && last.role === 'assistant' && last.tool_calls)).toBe(false);
    // The reloaded history is a valid OpenAI sequence for the very next turn.
    await expect(
      provider.chat([...history, { role: 'user', content: 'next' }]),
    ).resolves.toBeDefined();
  });
});

// F6 (P2b/D1.6, revised by the Wave-D panel M5): compaction persists via a best-effort WINDOW save (the
// day-file archive is never rewritten — DD1). A failing window save must warn-and-continue (never reject
// the turn). M5 / spec 14 §4: a plain compaction is candidate-then-swap — a FAILED save keeps the OLD
// window (in memory too), so disk and memory never diverge. (The ≥80% emergency truncate is the sole
// exception — it must reduce in memory regardless, as the overflow valve; covered in
// session-compaction-panel-fixes.test.ts.)
describe('Compaction window-save failure degrades gracefully (F6 / M5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-compaction-f6-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('no-LLM branch: a failing window save does not reject and keeps the OLD window (M5)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new SessionManager(240, 1440, tmpDir, undefined, undefined, {
      enabled: true,
      triggerAtTokenPercent: 80,
      memoryFlush: false,
      keepRecentTurns: 2,
    });
    const chatId = 'chat-f6a';
    for (let i = 0; i < 4; i++) {
      await manager.addTurn(chatId, { role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` });
    }

    const writeSpy = jest.spyOn(fsRealForFixes, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(manager.runCompaction(chatId)).resolves.toBeUndefined(); // best-effort: never rejects
    writeSpy.mockRestore();

    // M5 candidate-then-swap: the window save failed, so the compaction is NOT applied — the old window
    // (all 4 turns) is retained in memory, matching disk. No memory/disk divergence.
    expect(manager.getHistory(chatId).map((m) => m.content)).toEqual(['u0', 'a0', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
  });

  it('olderTurns===0 branch: persist failure does not reject; history unchanged', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = makeStrictProvider('summary', 'gpt-5.6-luna');
    const manager = new SessionManager(240, 1440, tmpDir, provider, undefined, {
      enabled: true,
      triggerAtTokenPercent: 80,
      memoryFlush: false,
      keepRecentTurns: 10, // > history length -> olderTurns empty
    });
    const chatId = 'chat-f6b';
    await manager.addTurn(chatId, { role: 'user', content: 'u0' }, { role: 'assistant', content: 'a0' });
    const before = manager.getHistory(chatId).map((m) => m.content);

    const writeSpy = jest.spyOn(fsRealForFixes, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(manager.runCompaction(chatId)).resolves.toBeUndefined();
    writeSpy.mockRestore();

    expect(manager.getHistory(chatId).map((m) => m.content)).toEqual(before);
  });
});

// P2b/D3.6 (DD9): the F9 archive-summary PHI test is RETIRED with its feature — generateSummary +
// the summaries/ side-file no longer exist. The surviving compaction pipeline never PERSISTS error
// text: a summary failure keeps the old window (nothing written), and the daily-log summary copy runs
// only on success (a real summary, no error). PHI-in-logs stays enforced by summarizeErrorForLog at
// every compaction catch. (Was: "Session summary never persists a raw provider error".)
