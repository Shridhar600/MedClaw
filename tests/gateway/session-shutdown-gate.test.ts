import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from '../../src/gateway/session';
import { DaemonShutdownError } from '../../src/shared/errors';
import { makeTestTemp } from '../helpers/test-temp';

describe('SessionManager isShutdown write-gate', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-session-');
    manager = new SessionManager(tmpDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const dayFile = (): string => path.join(tmpDir, new Date().toISOString().slice(0, 10) + '.jsonl');

  it('recordTurn rejects with DaemonShutdownError once shut down, and writes NOTHING to the day-file archive', async () => {
    manager.setShutdownGate(() => true);
    await expect(manager.recordTurn('chat1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])).rejects.toBeInstanceOf(DaemonShutdownError);
    expect(fs.existsSync(dayFile())).toBe(false);
  });

  it('recordPromptUsage rejects with DaemonShutdownError once shut down', async () => {
    manager.setShutdownGate(() => true);
    await expect(manager.recordPromptUsage('chat1', 42)).rejects.toBeInstanceOf(DaemonShutdownError);
  });

  it('runCompaction rejects with DaemonShutdownError once shut down, before ever invoking the LLM/tool pipeline', async () => {
    const chat = jest.fn();
    manager = new SessionManager({
      sessionsPath: tmpDir,
      provider: { modelName: 'test', chat, embed: jest.fn() },
    });
    manager.setShutdownGate(() => true);
    await expect(manager.runCompaction('chat1')).rejects.toBeInstanceOf(DaemonShutdownError);
    expect(chat).not.toHaveBeenCalled();
  });

  it('an in-flight turn (gate still false when called) is unaffected — normal recordTurn still succeeds', async () => {
    manager.setShutdownGate(() => false);
    await expect(manager.recordTurn('chat1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])).resolves.toBeDefined();
    expect(fs.existsSync(dayFile())).toBe(true);
  });

  it('a SessionManager with no shutdown gate wired (legacy/tests) never gates — behavior-preserving default', async () => {
    await expect(manager.recordTurn('chat1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])).resolves.toBeDefined();
  });
});
