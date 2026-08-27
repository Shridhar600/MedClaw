import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SessionManager } from '../../src/gateway/session';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';

const tmpDirs: string[] = [];

function tmpSessions(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-emergency-'));
  tmpDirs.push(dir);
  const sessionsPath = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  return sessionsPath;
}

function countingProvider(): { provider: LLMProvider; calls: () => number } {
  let n = 0;
  return {
    provider: {
      modelName: 'test-model',
      async chat(): Promise<LLMResponse> {
        n++;
        return { type: 'text', text: '- durable summary point' };
      },
      async embed(): Promise<number[]> {
        return [];
      },
    },
    calls: () => n,
  };
}

const compaction = { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 };

async function seed(mgr: SessionManager, chatId: string, turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await mgr.recordTurn(chatId, [
      { role: 'user', content: `user message ${i} with padding` },
      { role: 'assistant', content: `assistant reply ${i} with padding` },
    ]);
  }
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('prepareHistory real-token triggers (spec 14 §3, A-MF3)', () => {
  it('emergency (≥80%) compacts SYNCHRONOUSLY before returning the window', async () => {
    const sessionsPath = tmpSessions();
    const { provider } = countingProvider();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mgr = new SessionManager({ sessionsPath, provider, compaction, contextWindow: 1000 });
    await seed(mgr, 'chat1', 8);
    await mgr.recordPromptUsage('chat1', 850); // 85% → emergency
    const before = mgr.getHistory('chat1').length;

    const prepared = await mgr.prepareHistory('chat1');
    warn.mockRestore();

    expect(prepared.length).toBeLessThan(before);
    expect(prepared[0].role).toBe('system');
    expect(prepared[0].content).toContain('Previous conversation summary');
  });

  it('compact (≥50% & <80%) runs in the BACKGROUND — the first prepareHistory returns the current window, a later one is compacted', async () => {
    const sessionsPath = tmpSessions();
    const { provider } = countingProvider();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mgr = new SessionManager({ sessionsPath, provider, compaction, contextWindow: 1000 });
    await seed(mgr, 'chat1', 8);
    await mgr.recordPromptUsage('chat1', 600); // 60% → compact
    const before = mgr.getHistory('chat1').length;

    const p1 = await mgr.prepareHistory('chat1');
    expect(p1.length).toBe(before); // not yet compacted — the pipeline is deferred

    const p2 = await mgr.prepareHistory('chat1'); // the background compaction has landed
    warn.mockRestore();
    expect(p2.length).toBeLessThan(before);
    expect(p2[0].content).toContain('Previous conversation summary');
  });

  it('under-threshold (<35%) does not compact and never calls the provider', async () => {
    const sessionsPath = tmpSessions();
    const { provider, calls } = countingProvider();
    const mgr = new SessionManager({ sessionsPath, provider, compaction, contextWindow: 1000 });
    await seed(mgr, 'chat1', 3);
    await mgr.recordPromptUsage('chat1', 100); // 10% → none

    const prepared = await mgr.prepareHistory('chat1');
    expect(prepared.length).toBe(6);
    expect(calls()).toBe(0);
  });

  it('the same token reading triggers at most one compaction (A-MF3 in-flight / consume-once)', async () => {
    const sessionsPath = tmpSessions();
    const { provider, calls } = countingProvider();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mgr = new SessionManager({ sessionsPath, provider, compaction, contextWindow: 1000 });
    await seed(mgr, 'chat1', 8);
    await mgr.recordPromptUsage('chat1', 850); // 85% → emergency

    await mgr.prepareHistory('chat1');
    await mgr.prepareHistory('chat1');
    warn.mockRestore();
    expect(calls()).toBe(1); // the second call sees the reading already consumed
  });

  it('A-M3 escape valve: emergency ALWAYS runs even with compaction.enabled=false (no-LLM truncate)', async () => {
    const sessionsPath = tmpSessions();
    const { provider, calls } = countingProvider();
    const mgr = new SessionManager({
      sessionsPath,
      provider,
      compaction: { ...compaction, enabled: false },
      contextWindow: 1000,
    });
    await seed(mgr, 'chat1', 8);
    await mgr.recordPromptUsage('chat1', 850); // 85% → emergency
    const before = mgr.getHistory('chat1').length;

    const prepared = await mgr.prepareHistory('chat1');

    expect(prepared.length).toBeLessThan(before); // truncated despite enabled:false
    expect(calls()).toBe(0); // no-LLM clean-split (no summary provider call)
    expect(prepared.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('Previous conversation summary'))).toBe(false);
  });
});
