import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../src/gateway/session';
import { DaemonShutdownError } from '../../src/shared/errors';

// RR-STRUCT R-S4 (mini-plan v3 §3.9): the session-archive writes (recordTurn/recordPromptUsage/
// runCompaction) do NOT go through the MutationCoordinator — they write the day-file JSONL
// archive directly and feed the SqliteSessionIndex (one of the 7 SQLite handles ProfileRuntime
// retains+closes). A late write after the owning runtime has closed its stores must refuse
// cleanly with a typed DaemonShutdownError, BEFORE touching disk/the op queue — never throw
// against a closed handle.
describe('RR-STRUCT R-S4 — SessionManager isShutdown write-gate', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs4-session-'));
    manager = new SessionManager(240, 1440, tmpDir);
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
      softResetMinutes: 240,
      hardResetMinutes: 1440,
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
    // No setShutdownGate() call at all — must behave exactly as before R-S4.
    await expect(manager.recordTurn('chat1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])).resolves.toBeDefined();
  });
});
