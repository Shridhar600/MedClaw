import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { LLMProvider } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';

// I3: compaction LLM calls are the LARGEST request a session makes, so on
// free/shared-pool providers they are the most exposed to transient upstream
// rate limits (live soak 2026-08-25: both compaction attempts died on 429s that
// passed seconds later). Retry with backoff before degrading.

describe('Compaction LLM retry (I3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-compaction-retry-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeManager(provider: LLMProvider): SessionManager {
    const manager = new SessionManager(
      240,
      1440,
      tmpDir,
      provider,
      undefined,
      { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
    );
    // Test-speed backoff; production default is 1500ms.
    manager.setCompactionRetryPolicy({ attempts: 3, backoffMs: 1 });
    return manager;
  }

  it('retries a transient failure and completes compaction', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      chat: jest.fn().mockImplementation(() => {
        calls += 1;
        if (calls < 3) {
          const err = new Error('429 too many requests');
          (err as Error & { status?: number }).status = 429;
          return Promise.reject(err);
        }
        return Promise.resolve({ type: 'text', text: 'Recovered summary of older turns.' });
      }),
      embed: jest.fn(),
    } as unknown as LLMProvider;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const manager = makeManager(provider);
    for (let i = 0; i < 6; i++) {
      await manager.addTurn(
        `chat-r`,
        { role: 'user', content: `Seed user ${i}` },
        { role: 'assistant', content: `Seed assistant ${i}` },
      );
    }

    await expect(manager.runCompaction('chat-r')).resolves.toBeUndefined();

    expect(calls).toBe(3);
    const history = manager.getHistory('chat-r');
    // Compacted: summary system message + the kept recent turns (2).
    expect(history[0].role).toBe('system');
    expect(history[0].content).toContain('Recovered summary');
    expect(history.length).toBeLessThan(12);

    warnSpy.mockRestore();
  });

  it('degrades gracefully after exhausting retries (history falls back to recent turns)', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      chat: jest.fn().mockImplementation(() => {
        calls += 1;
        const err = new Error('429 still rate-limited');
        (err as Error & { status?: number }).status = 429;
        return Promise.reject(err);
      }),
      embed: jest.fn(),
    } as unknown as LLMProvider;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const manager = makeManager(provider);
    for (let i = 0; i < 6; i++) {
      await manager.addTurn(
        'chat-fail',
        { role: 'user', content: `Seed user ${i}` },
        { role: 'assistant', content: `Seed assistant ${i}` },
      );
    }

    await expect(manager.runCompaction('chat-fail')).resolves.toBeUndefined();

    expect(calls).toBe(3); // exhausted all attempts, no infinite loop
    const history = manager.getHistory('chat-fail');
    // Fallback keeps ONLY recent turns (older dropped unsummarized) — same as pre-I3 degrade.
    expect(history.every((m) => m.role !== 'system')).toBe(true);
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThan(12);

    warnSpy.mockRestore();
  });

  it('does NOT retry deterministic 4xx errors (single attempt)', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      chat: jest.fn().mockImplementation(() => {
        calls += 1;
        const err = new Error('400 bad request: invalid message shape');
        (err as Error & { status?: number }).status = 400;
        return Promise.reject(err);
      }),
      embed: jest.fn(),
    } as unknown as LLMProvider;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const manager = makeManager(provider);
    for (let i = 0; i < 6; i++) {
      await manager.addTurn(
        'chat-4xx',
        { role: 'user', content: `Seed user ${i}` },
        { role: 'assistant', content: `Seed assistant ${i}` },
      );
    }

    await expect(manager.runCompaction('chat-4xx')).resolves.toBeUndefined();
    expect(calls).toBe(1); // deterministic failure — no retry burned

    warnSpy.mockRestore();
  });
});
