import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SessionManager, turnAwareSplit, estimateTokens } from '../../src/gateway/session';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';

// P2b Wave D hostile-panel fix-pass — compaction concurrency + correctness.
//   H1  emergency during an in-flight compact must NOT start a 2nd LLM pipeline (await the existing one).
//   H2  the compaction LLM runs OFF the per-chat write queue (a held summary must not block recordTurn).
//   H3  a repeat compaction preserves the prior summary's facts + anchors (never re-summarizes them away).
//   H4  retention is turn-aware (keeps complete user→next-user spans; never drops the user half).
//   H6  a memory-flush failure is a failed step ⇒ keep the OLD window (do not fall through to a summary).
//   M3  a model-supplied sessions/<file>#L<n> anchor is validated/replaced, never trusted verbatim.
//   M4  the no-LLM emergency truncate preserves a leading summary (metadata), not treated as a turn.
//   RES the emergency truncate reduces IN MEMORY even when the window save fails (overflow valve).

const tmpDirs: string[] = [];
function tmpSessions(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-panelfix-'));
  tmpDirs.push(dir);
  const sessionsPath = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  return sessionsPath;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const compaction = { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** A provider whose chat() blocks until released — lets a compaction sit "in flight". */
function heldProvider(): { provider: LLMProvider; calls: () => number; release: () => void } {
  let n = 0;
  let pending: Array<() => void> = [];
  return {
    provider: {
      modelName: 'test-model',
      async chat(): Promise<LLMResponse> {
        n += 1;
        const mine = n;
        await new Promise<void>((res) => pending.push(res));
        return { type: 'text', text: `- summary point ${mine}` };
      },
      async embed(): Promise<number[]> {
        return [];
      },
    },
    calls: () => n,
    release: () => {
      const p = pending;
      pending = [];
      p.forEach((r) => r());
    },
  };
}

function textProvider(text: string): LLMProvider {
  return {
    modelName: 'test-model',
    async chat(): Promise<LLMResponse> {
      return { type: 'text', text };
    },
    async embed(): Promise<number[]> {
      return [];
    },
  };
}

async function seed(mgr: SessionManager, chatId: string, turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await mgr.recordTurn(chatId, [
      { role: 'user', content: `user message ${i} padding padding` },
      { role: 'assistant', content: `assistant reply ${i} padding padding` },
    ]);
  }
}

describe('turnAwareSplit (H4)', () => {
  it('keeps the complete last-N turns starting at a user message (never an orphaned half-turn)', () => {
    const h: Message[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', content: 'r', tool_call_id: 't' },
      { role: 'assistant', content: 'a2' },
    ];
    // keep the last 1 turn → the split lands on u2 (index 2), keeping [u2, asst(tool), tool, a2].
    const split = turnAwareSplit(h, 1);
    expect(split).toBe(2);
    expect(h[split].role).toBe('user');
    expect(h.slice(split).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('keeps everything when there are fewer turns than keepTurns', () => {
    const h: Message[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ];
    expect(turnAwareSplit(h, 5)).toBe(0);
  });
});

describe('compaction retention is turn-aware (H4 — never drops the user half of a tool turn)', () => {
  it('a compacted window keeps the user question of the most recent tool turn', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath, provider: textProvider('- older summary'), compaction: { ...compaction, keepRecentTurns: 1 } });
    await mgr.recordTurn('c', [
      { role: 'user', content: 'older q1' },
      { role: 'assistant', content: 'older a1' },
    ]);
    await mgr.recordTurn('c', [
      { role: 'user', content: 'recent clinical question' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'memory_read', arguments: '{}' } }] },
      { role: 'tool', content: 'glucose 300', tool_call_id: 't1' },
      { role: 'assistant', content: 'recent answer' },
    ]);
    await mgr.runCompaction('c');
    const history = mgr.getHistory('c');
    // the recent turn's USER question must survive verbatim in the kept tail.
    expect(history.some((m) => m.role === 'user' && m.content === 'recent clinical question')).toBe(true);
  });
});

describe('emergency does not start a 2nd compaction pipeline while one is in flight (H1)', () => {
  it('awaits the in-flight background compaction instead of calling the summary LLM twice', async () => {
    const sessionsPath = tmpSessions();
    const held = heldProvider();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mgr = new SessionManager({ sessionsPath, provider: held.provider, compaction, contextWindow: 1000 });
    await seed(mgr, 'c', 8);

    await mgr.recordPromptUsage('c', 600); // 60% → background compact
    await mgr.prepareHistory('c'); // schedules the background compaction (LLM now held)
    await tick();
    expect(held.calls()).toBe(1); // the background summary LLM is in flight

    await mgr.recordPromptUsage('c', 850); // 85% → emergency on the NEXT prepareHistory
    const pEmergency = mgr.prepareHistory('c'); // must AWAIT the in-flight, not start a 2nd pipeline
    await tick();
    expect(held.calls()).toBe(1); // STILL one — H1: no 2nd summary pipeline

    held.release();
    await pEmergency;
    warn.mockRestore();
    expect(held.calls()).toBe(1);
  });
});

describe('the compaction LLM runs off the write queue (H2)', () => {
  it('a recordTurn completes while a background summary LLM is held (queue not blocked)', async () => {
    const sessionsPath = tmpSessions();
    const held = heldProvider();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mgr = new SessionManager({ sessionsPath, provider: held.provider, compaction, contextWindow: 1000 });
    await seed(mgr, 'c', 8);
    await mgr.recordPromptUsage('c', 600); // 60% → background compact
    await mgr.prepareHistory('c');
    await tick();
    expect(held.calls()).toBe(1); // LLM held

    // While the summary LLM is held, a new turn must still persist (not queued behind the LLM).
    const recorded = mgr.recordTurn('c', [
      { role: 'user', content: 'urgent new turn' },
      { role: 'assistant', content: 'ack' },
    ]);
    const winner = await Promise.race([
      recorded.then(() => 'recorded' as const),
      new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 250)),
    ]);
    expect(winner).toBe('recorded');

    held.release();
    await recorded;
    warn.mockRestore();
  });
});

describe('repeat compaction preserves the prior summary (H3)', () => {
  it('a second compaction keeps the first summary bullets + anchors and only appends new ones', async () => {
    const sessionsPath = tmpSessions();
    // first compaction yields a glucose fact; a second compaction returns an unrelated line.
    let call = 0;
    const provider: LLMProvider = {
      modelName: 'test-model',
      async chat(): Promise<LLMResponse> {
        call += 1;
        return { type: 'text', text: call === 1 ? '- glucose 300 recorded' : '- unrelated new point' };
      },
      async embed(): Promise<number[]> {
        return [];
      },
    };
    const mgr = new SessionManager({ sessionsPath, provider, compaction: { ...compaction, keepRecentTurns: 2 } });
    await seed(mgr, 'c', 6);
    await mgr.runCompaction('c'); // first summary → glucose fact
    const afterFirst = mgr.getHistory('c')[0].content as string;
    expect(afterFirst).toContain('glucose 300');

    await seed(mgr, 'c', 4); // more turns
    await mgr.runCompaction('c'); // second compaction
    const afterSecond = mgr.getHistory('c')[0].content as string;
    // H3: the first summary's fact is STILL present (not re-summarized away), plus the new point.
    expect(afterSecond).toContain('glucose 300');
    expect(afterSecond).toContain('unrelated new point');
  });
});

describe('a memory-flush failure keeps the old window (H6)', () => {
  it('does not fall through to the summary step when the flush call fails', async () => {
    const sessionsPath = tmpSessions();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let summaryCalled = false;
    const provider: LLMProvider = {
      modelName: 'test-model',
      async chat(messages: Message[]): Promise<LLMResponse> {
        const isFlush = messages.some((m) => typeof m.content === 'string' && m.content.includes('persist durable memory'));
        if (isFlush) {
          const err = new Error('400 flush failed');
          (err as Error & { status?: number }).status = 400;
          throw err;
        }
        summaryCalled = true;
        return { type: 'text', text: '- should not be produced' };
      },
      async embed(): Promise<number[]> {
        return [];
      },
    };
    const toolRegistry = {
      getAvailable: () => [{ name: 'memory_write', description: 'w', group: 'group:memory', parameters: { properties: {}, required: [] } }],
      execute: jest.fn(async () => 'ok'),
    } as unknown as import('../../src/tools/registry').ToolRegistry;
    const mgr = new SessionManager({ sessionsPath, provider, toolRegistry, compaction: { ...compaction, memoryFlush: true } });
    await seed(mgr, 'c', 6);
    const before = mgr.getHistory('c').length;

    await mgr.runCompaction('c');
    warn.mockRestore();

    expect(summaryCalled).toBe(false); // H6: flush failed → do not summarize
    expect(mgr.getHistory('c').length).toBe(before); // old window kept
    expect(mgr.getHistory('c').every((m) => m.role !== 'system')).toBe(true);
  });
});

describe('a model-supplied anchor is validated, not trusted (M3)', () => {
  it('strips a bogus sessions/<file>#L<n> from the model summary and replaces it with an in-range anchor', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({
      sessionsPath,
      provider: textProvider('- fact one (sessions/not-a-real-day.jsonl#L999999)\n- fact two'),
      compaction,
    });
    await seed(mgr, 'c', 6);
    await mgr.runCompaction('c');
    const summary = mgr.getHistory('c')[0].content as string;

    expect(summary).not.toContain('not-a-real-day.jsonl#L999999'); // the bogus anchor is gone
    // every remaining anchor points at a real day file (basename YYYY-MM-DD.jsonl).
    const anchors = [...summary.matchAll(/sessions\/(\S+?)#L(\d+)/g)];
    expect(anchors.length).toBeGreaterThan(0);
    for (const m of anchors) {
      expect(m[1]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    }
  });
});

describe('no-LLM emergency truncate preserves a leading summary (M4)', () => {
  it('keeps the summary system message and only truncates the verbatim tail', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({
      sessionsPath,
      compaction: { ...compaction, enabled: false, keepRecentTurns: 2 },
      contextWindow: 1000,
    });
    // Hand-build a window with a leading summary + several verbatim turns, then force emergency.
    await mgr.recordTurn('c', [
      { role: 'system', content: '[Previous conversation summary]\n- pinned fact (sessions/2026-08-30.jsonl#L1)' },
    ]);
    await seed(mgr, 'c', 6);
    await mgr.recordPromptUsage('c', 850); // 85% → emergency (no-LLM, enabled:false)
    const prepared = await mgr.prepareHistory('c');

    expect(prepared[0].role).toBe('system');
    expect(prepared[0].content).toContain('pinned fact'); // M4: the summary survived the truncate
  });
});

describe('chars/4 fallback is conservative for the untracked system prompt + tools (M2)', () => {
  it('a fallback reading exceeds the bare history estimate so a large real prompt is not under-reported', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath, contextWindow: 10000 });
    await mgr.recordTurn('c', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    await mgr.recordPromptUsage('c'); // no tokens → the chars/4 estimate fallback
    const bareEstimatePct = (estimateTokens(mgr.getHistory('c')) / 10000) * 100;
    // The real prompt also carries the system prompt + tool schemas (not in session.history); the fallback
    // must add a conservative overhead so a small history isn't reported as ~0% while the real prompt is large.
    expect(mgr.windowFillPercent('c')).toBeGreaterThan(bareEstimatePct);
  });
});

describe('emergency truncate reduces in memory even when the window save fails (overflow valve)', () => {
  it('applies the truncation despite a failing saveWindow (best-effort persistence)', async () => {
    const sessionsPath = tmpSessions();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mgr = new SessionManager({
      sessionsPath,
      compaction: { ...compaction, enabled: false, keepRecentTurns: 2 },
      contextWindow: 1000,
    });
    await seed(mgr, 'c', 8);
    await mgr.recordPromptUsage('c', 850);
    const before = mgr.getHistory('c').length;

    const realFs = jest.requireActual<typeof import('fs')>('fs');
    const writeSpy = jest.spyOn(realFs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    const prepared = await mgr.prepareHistory('c');
    writeSpy.mockRestore();
    warn.mockRestore();

    expect(prepared.length).toBeLessThan(before); // the valve still reduced the window
  });
});
