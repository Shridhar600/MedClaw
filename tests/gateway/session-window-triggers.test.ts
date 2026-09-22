import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SessionManager, windowTriggerFor } from '../../src/gateway/session';
import { loadWindow } from '../../src/gateway/session-window';

const tmpDirs: string[] = [];

function tmpSessions(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-triggers-'));
  tmpDirs.push(dir);
  const sessionsPath = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  return sessionsPath;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('SessionManager.recordPromptUsage (DD3 token signal)', () => {
  it('persists a real prompt-token reading on the window (not flagged estimated)', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath });
    await mgr.recordTurn('chat1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    await mgr.recordPromptUsage('chat1', 1234);

    const w = loadWindow(path.join(sessionsPath, 'session-window.json'));
    expect(w?.lastPromptTokens).toBe(1234);
    expect(w?.lastPromptTokensEstimated).toBeFalsy();
  });

  it('falls back to a chars/4 estimate (flagged) when the provider omitted usage', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath });
    await mgr.recordTurn('chat1', [
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'ok' },
    ]);
    await mgr.recordPromptUsage('chat1', undefined);

    const w = loadWindow(path.join(sessionsPath, 'session-window.json'));
    expect(w?.lastPromptTokensEstimated).toBe(true);
    expect(w?.lastPromptTokens).toBeGreaterThan(0);
  });

  it('a restart resumes the persisted token reading', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath });
    await mgr.recordTurn('chat1', [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
    await mgr.recordPromptUsage('chat1', 4096);

    // Fresh manager over the same dir → the resumed window carries the token reading.
    const mgr2 = new SessionManager({ sessionsPath });
    await mgr2.recordTurn('chat1', [{ role: 'user', content: 'more' }, { role: 'assistant', content: 'ok' }]);
    const w = loadWindow(path.join(sessionsPath, 'session-window.json'));
    expect(w?.lastPromptTokens).toBe(4096);
  });
});

describe('windowTriggerFor — the spec 14 §3 threshold table (34/35/49/50/80)', () => {
  const t = { pruneAtPercent: 35, compactAtPercent: 50, emergencyAtPercent: 80 };

  it.each([
    [0, 'none'],
    [34, 'none'],
    [34.9, 'none'],
    [35, 'prune'],
    [49, 'prune'],
    [49.9, 'prune'],
    [50, 'compact'],
    [79, 'compact'],
    [79.9, 'compact'],
    [80, 'emergency'],
    [95, 'emergency'],
  ] as const)('fill %s%% → %s', (fill, expected) => {
    expect(windowTriggerFor(fill, t)).toBe(expected);
  });
});

describe('SessionManager.windowFillPercent', () => {
  it('reflects the recorded token reading against the effective context window', async () => {
    const sessionsPath = tmpSessions();
    // No provider ⇒ contextWindowFor(undefined) = 8192. 4096/8192 = 50%.
    const mgr = new SessionManager({ sessionsPath });
    await mgr.recordTurn('chat1', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]);
    await mgr.recordPromptUsage('chat1', 4096);
    expect(mgr.windowFillPercent('chat1')).toBeCloseTo(50, 5);
  });

  it('honors an explicit config contextWindow over the per-model table', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath, contextWindow: 1000 });
    await mgr.recordTurn('chat1', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]);
    await mgr.recordPromptUsage('chat1', 350);
    expect(mgr.windowFillPercent('chat1')).toBeCloseTo(35, 5);
  });

  it('is 0 when no usage has been recorded', () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath });
    expect(mgr.windowFillPercent('chat1')).toBe(0);
  });
});
