import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager } from '../../src/gateway/session';

describe('SessionManager Enqueue Fix', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-enqueue-'));
    manager = new SessionManager(240, 1440, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('handles 10 concurrent recordTurn calls on the same chatId without losing data', async () => {
    const chatId = 'chat-race';

    const turns = Array.from({ length: 10 }, (_, i) => {
      return manager.recordTurn(chatId, [
        { role: 'user' as const, content: `Message ${i}` },
        { role: 'assistant' as const, content: `Response ${i}` },
      ]);
    });

    await Promise.all(turns);

    const history = manager.getHistory(chatId);
    expect(history).toHaveLength(20); // 10 user + 10 assistant

    for (let i = 0; i < 10; i++) {
      expect(history[i * 2].content).toBe(`Message ${i}`);
      expect(history[i * 2 + 1].content).toBe(`Response ${i}`);
    }
  });

  it('preserves message order for concurrent recordTurn calls', async () => {
    const chatId = 'chat-order';

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        manager.recordTurn(chatId, [
          { role: 'user' as const, content: `Message ${i}` },
          { role: 'assistant' as const, content: `Response ${i}` },
        ]),
      );
    }

    await Promise.all(promises);

    const history = manager.getHistory(chatId);
    const contents = history.map(m => m.content);
    const expected = Array.from({ length: 10 }, (_, i) => [`Message ${i}`, `Response ${i}`]).flat();
    expect(contents).toEqual(expected);
  });

  it('queue map is empty after all concurrent operations complete', async () => {
    const chatId = 'chat-cleanup';

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        manager.recordTurn(chatId, [
          { role: 'user' as const, content: `Message ${i}` },
          { role: 'assistant' as const, content: `Response ${i}` },
        ]),
      );
    }

    await Promise.all(promises);

    // Access private operationQueues to verify cleanup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queues = (manager as any).operationQueues as Map<string, unknown>;
    expect(queues.has(chatId)).toBe(false);
  });

  it('different chatIds have independent queues', async () => {
    const chatA = 'chat-a';
    const chatB = 'chat-b';

    await Promise.all([
      manager.recordTurn(chatA, [
        { role: 'user' as const, content: 'A msg' },
        { role: 'assistant' as const, content: 'A resp' },
      ]),
      manager.recordTurn(chatB, [
        { role: 'user' as const, content: 'B msg' },
        { role: 'assistant' as const, content: 'B resp' },
      ]),
    ]);

    const historyA = manager.getHistory(chatA);
    const historyB = manager.getHistory(chatB);
    expect(historyA).toHaveLength(2);
    expect(historyB).toHaveLength(2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queues = (manager as any).operationQueues as Map<string, unknown>;
    expect(queues.has(chatA)).toBe(false);
    expect(queues.has(chatB)).toBe(false);
  });
});
