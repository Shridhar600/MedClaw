import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SessionManager } from '../../src/gateway/session';
import { dateKey, countDayFileLines } from '../../src/gateway/session-window';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';

const tmpDirs: string[] = [];

function tmpSessions(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-compact-pipe-'));
  tmpDirs.push(dir);
  const sessionsPath = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  return sessionsPath;
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

function throwingProvider(): LLMProvider {
  return {
    modelName: 'test-model',
    async chat(): Promise<LLMResponse> {
      const err = new Error('400 deterministic failure');
      (err as Error & { status?: number }).status = 400;
      throw err;
    },
    async embed(): Promise<number[]> {
      return [];
    },
  };
}

const compaction = { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 };

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('Compaction pipeline (spec 14 §4)', () => {
  it('produces an anchored summary + recent tail; every bullet anchor resolves; the day file is untouched', async () => {
    const sessionsPath = tmpSessions();
    const summary = '- Patient reported knee pain\n- Started metformin 500mg\n- Follow up next week';
    const mgr = new SessionManager({ sessionsPath, provider: textProvider(summary), compaction });

    for (let n = 1; n <= 6; n++) {
      await mgr.recordTurn('chat1', [
        { role: 'user', content: `user message ${n}` },
        { role: 'assistant', content: `assistant reply ${n}` },
      ]);
    }

    const dayFile = path.join(sessionsPath, `${dateKey(new Date())}.jsonl`);
    const before = fs.readFileSync(dayFile, 'utf8');

    await mgr.runCompaction('chat1');

    const after = fs.readFileSync(dayFile, 'utf8');
    const history = mgr.getHistory('chat1');

    // Window = [summary system message, ...the kept recent tail]. H4 turn-aware: keepRecentTurns=2 keeps
    // the last 2 TURNS = 4 messages (u5,a5,u6,a6), so the window is 1 summary + 4.
    expect(history[0].role).toBe('system');
    expect(history[0].content).toContain('[Previous conversation summary]');
    expect(history.length).toBe(1 + 4);

    // Every bullet anchor resolves to a real day-file line (spec 14 §4.2 anchor validity).
    const anchors = [...(history[0].content as string).matchAll(/sessions\/(\S+?)#L(\d+)/g)];
    expect(anchors.length).toBeGreaterThan(0);
    for (const m of anchors) {
      const count = countDayFileLines(path.join(sessionsPath, m[1]));
      const line = Number(m[2]);
      expect(line).toBeGreaterThanOrEqual(1);
      expect(line).toBeLessThanOrEqual(count);
    }

    // Disk day-file archive is byte-identical — compaction never rewrites it (DD1).
    expect(after).toBe(before);
  });

  it('a summary LLM failure keeps the OLD window unchanged (spec 14 §4: never lose the thread)', async () => {
    const sessionsPath = tmpSessions();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mgr = new SessionManager({ sessionsPath, provider: throwingProvider(), compaction });

    for (let n = 1; n <= 6; n++) {
      await mgr.recordTurn('chat1', [
        { role: 'user', content: `user message ${n}` },
        { role: 'assistant', content: `assistant reply ${n}` },
      ]);
    }
    const beforeHistory = mgr.getHistory('chat1').length; // 12

    await expect(mgr.runCompaction('chat1')).resolves.toBeUndefined();

    const history = mgr.getHistory('chat1');
    warn.mockRestore();
    // Old window retained in full: no summary added, no older turns dropped.
    expect(history.length).toBe(beforeHistory);
    expect(history.every((m) => m.role !== 'system')).toBe(true);
  });

  it('copies the summary bullets to a wired summary sink (spec 14 §4 step 4)', async () => {
    const sessionsPath = tmpSessions();
    const summary = '- Reported chest tightness\n- Advised to monitor';
    const mgr = new SessionManager({ sessionsPath, provider: textProvider(summary), compaction });

    const received: string[] = [];
    mgr.setSummarySink(async (_chatId, s) => {
      received.push(s);
    });

    for (let n = 1; n <= 6; n++) {
      await mgr.recordTurn('chat1', [
        { role: 'user', content: `user message ${n}` },
        { role: 'assistant', content: `assistant reply ${n}` },
      ]);
    }
    await mgr.runCompaction('chat1');

    expect(received).toHaveLength(1);
    expect(received[0]).toContain('chest tightness');
    expect(received[0]).toMatch(/sessions\/\S+#L\d+/); // the copied bullets carry anchors
  });
});
