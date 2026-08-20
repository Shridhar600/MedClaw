import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { ContextAssembler } from '../../src/agent/context';
import { InvariantViolationError } from '../../src/shared/errors';
import type { AppConfig } from '../../src/config/types';

// Task 13 — the v2 memory core wired behind the live Gateway: ledger/episode/safety tool
// groups registered per profile, the ledger tools driving both lanes + SAFETY.md, the
// per-turn narrative capture hook (F4/CHAT-06), and the boot-time SAFETY invariant (D9).

function makeConfig(tmpDir: string): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'kimi-k2.5:cloud', baseUrl: 'http://localhost:11434/v1' },
      medical: { type: 'ollama', model: 'medgemma', baseUrl: 'http://localhost:11434/v1' },
      embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: path.join(tmpDir, 'workspace'),
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
      policy: {
        quietHours: { enabled: true, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 60,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 15, disclaimerEnabled: true },
  };
}

const today = (): string => new Date().toISOString().slice(0, 10);

describe('Gateway memory-core wiring (Task 13)', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-memcore-wire-'));
    workspace = path.join(tmpDir, 'workspace');
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => (gateway as any).agentLoop.registry;

  it('registers the ledger, episode, and safety tool groups', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore();

    const names = registryOf().getAvailable().map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['ledger_record', 'ledger_update', 'ledger_query', 'episode_manage', 'safety_note']));
  });

  it('ledger_record via the registry writes the ledger, SAFETY.md, and the narrative cross-anchor', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore();

    const res = await registryOf().execute('ledger_record', {
      entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, note: 'started metformin 500mg',
    });
    expect(res.isError).toBeFalsy();

    expect(fs.existsSync(path.join(workspace, 'ledger', 'medications.md'))).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'SAFETY.md'), 'utf8')).toContain('metformin');
    const narrative = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    expect(narrative).toContain('## Ledger writes');
    expect(narrative).toContain('metformin →');
  });

  it('captures raw user text into the narrative lane every turn (F4/CHAT-06)', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore();

    // Skip onboarding + stub the agent so turns reach the capture + agent path deterministically.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).handleOnboarding = async (): Promise<null> => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run: async (): Promise<unknown> => ({ text: 'ok', trace: [{ role: 'assistant', content: 'ok' }] }) };

    await gateway.handleTestMessage('chat-1', 'I have a headache today');
    await gateway.handleTestMessage('chat-1', 'now my knee hurts too');

    const narrative = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    expect(narrative).toContain('I have a headache today');
    expect(narrative).toContain('now my knee hurts too');
  });

  it('aborts boot when the SAFETY.md injection invariant is violated (D9)', async () => {
    // The real assembler injects SAFETY.md non-truncatably (Task 5). Here we force the guard
    // to fire and assert start() does NOT swallow it — the daemon refuses to start.
    const spy = jest.spyOn(ContextAssembler.prototype, 'buildSystemMessages')
      .mockRejectedValue(new InvariantViolationError('SAFETY.md was not injected in full'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    gateway = new Gateway(makeConfig(tmpDir));

    await expect(gateway.start()).rejects.toBeInstanceOf(InvariantViolationError);

    spy.mockRestore();
    warn.mockRestore();
  });
});
