import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LLMProvider } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';

describe('RR-6b compaction summary durability', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr6b-summary-'));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('retains a failed summary sink as durable pending work and retries it on the next compaction call', async () => {
    const provider: LLMProvider = {
      chat: jest.fn().mockResolvedValue({ type: 'text', text: '- durable summary bullet' }),
      embed: jest.fn(),
    };
    const sink = jest.fn()
      .mockRejectedValueOnce(new Error('summary sink unavailable'))
      .mockResolvedValue(undefined);
    const manager = new SessionManager({
      sessionsPath: sessionsDir,
      provider,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
    });
    manager.setSummarySink(sink);
    for (let i = 0; i < 4; i++) {
      await manager.addTurn(
        'chat-1',
        { role: 'user', content: `user ${i}` },
        { role: 'assistant', content: `assistant ${i}` },
      );
    }

    await manager.runCompaction('chat-1');
    const windowPath = path.join(sessionsDir, 'session-window.json');
    const afterFailure = JSON.parse(fs.readFileSync(windowPath, 'utf8'));
    expect(afterFailure.pendingSummary).toContain('durable summary bullet');

    const restarted = new SessionManager({ sessionsPath: sessionsDir });
    restarted.setSummarySink(sink);
    await restarted.runCompaction('chat-1');

    expect(sink).toHaveBeenCalledTimes(2);
    const afterRetry = JSON.parse(fs.readFileSync(windowPath, 'utf8'));
    expect(afterRetry.pendingSummary).toBeUndefined();
  });
});
