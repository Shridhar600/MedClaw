import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { SafetyView } from '../../src/memcore';
import type { AppConfig } from '../../src/config/types';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';

// C3 — the prompt cutover: the live chat path builds its system prompt per turn through the v2
// assembler with recall injected and SAFETY re-rendered EVERY turn (D9). These are gateway-level
// integration tests over the REAL agentLoop + prepareSystem; only the chat PROVIDER is scripted so
// we can read back the assembled system message it is handed. Embeddings are unavailable in the test
// env, so every turn also exercises the recall keyword-only/degrade path (resilience).

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

/** Replace the chat provider on the live agentLoop with a capturing stub; returns the captured
 *  message arrays (each `chat()` call). Recall still uses the real (unavailable) embedding provider. */
function captureProvider(gateway: Gateway): Message[][] {
  const seen: Message[][] = [];
  const scripted: LLMProvider = {
    async chat(msgs: Message[]): Promise<LLMResponse> { seen.push(msgs); return { type: 'text', text: 'ok' }; },
    async embed(): Promise<number[]> { return []; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).agentLoop.provider = scripted;
  return seen;
}

async function startGateway(tmpDir: string): Promise<Gateway> {
  const gateway = new Gateway(makeConfig(tmpDir));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await gateway.start();
  warn.mockRestore();
  log.mockRestore();
  // Skip onboarding so chat turns reach the agent path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).handleOnboarding = async (): Promise<null> => null;
  return gateway;
}

describe('Gateway C3 — per-turn recall + v2 assembly cutover (D9)', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-recall-cutover-'));
    workspace = path.join(tmpDir, 'workspace');
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => (gateway as any).agentLoop.registry;
  const lastSystem = (seen: Message[][]): string => String(seen[seen.length - 1][0].content);

  it('re-renders SAFETY into the running prompt after a mid-session mutation, no restart (D9)', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);

    await gateway.handleTestMessage('chat-1', 'hello there');
    expect(lastSystem(seen)).not.toContain('penicillin');

    // Mid-session: record a safety-relevant allergy (D8 re-renders SAFETY.md).
    const res = await registryOf().execute('ledger_record', {
      entity: 'penicillin', type: 'allergy', fields: { reaction: 'hives' }, note: 'penicillin allergy, hives',
    });
    expect(res.isError).toBeFalsy();

    await gateway.handleTestMessage('chat-1', 'anything I should know before a new antibiotic');
    // The very next turn's prompt reflects the new SAFETY content WITHOUT any restart.
    expect(lastSystem(seen)).toContain('penicillin');
  });

  it('injects Stage-1 active-ledger one-liners on a heartbeat turn but not full MEMORY (KNEE-02)', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);

    await registryOf().execute('ledger_record', {
      entity: 'knee-injury', type: 'condition', fields: { status_note: 'MCL sprain, avoid heavy leg loading' },
      note: 'knee MCL sprain',
    });

    // Drive a heartbeat-mode turn directly (Gateway maps origin→mode for the scheduler path).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).agentLoop.run('heartbeat check-in', [], { chatId: 'chat-1', origin: 'heartbeat', mode: 'heartbeat' });

    const sys = lastSystem(seen);
    expect(sys).toContain('knee-injury');
    expect(sys).not.toContain('## MEMORY');
  });

  it('surfaces a due curiosity follow-up on the live heartbeat path', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const curiosity = (gateway as any).curiosity;
    await curiosity.add({
      kind: 'missing-data',
      description: 'Did I miss logging naproxen yesterday?',
      relatedEntity: 'naproxen',
      critical: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).agentLoop.run(
      'heartbeat check-in',
      [],
      { chatId: 'chat-1', origin: 'heartbeat', mode: 'heartbeat' },
    );

    expect(lastSystem(seen)).toContain('Did I miss logging naproxen yesterday?');
  });

  it('keeps live volatile health recall when MEMORY.md is oversized', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);
    fs.writeFileSync(
      path.join(workspace, 'MEMORY.md'),
      `# Memory\n\n## Health\n- ${'stable prose '.repeat(4_000)}\n`,
      'utf8',
    );

    const result = await registryOf().execute('ledger_record', {
      entity: 'lisinopril', type: 'medication', fields: { dose: '10mg' }, note: 'lisinopril 10mg',
    });
    expect(result.isError).toBeFalsy();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).agentLoop.run('what should I know today', [], { chatId: 'chat-1', mode: 'chat' });
    const system = lastSystem(seen);
    expect(system).toContain('lisinopril');
    expect(system).not.toContain('stable prose '.repeat(4_000));
  });

  it('reports per-turn prompt mode in /status when the recall path is wired (L-2)', async () => {
    gateway = await startGateway(tmpDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (gateway as any).buildBootStatusText();
    expect(status).toContain('prompt: per-turn');
  });

  it('completes a chat turn and injects SAFETY even with embeddings unavailable (recall degrades, no crash)', async () => {
    gateway = await startGateway(tmpDir);
    await registryOf().execute('ledger_record', {
      entity: 'lisinopril', type: 'medication', fields: { dose: '10mg' }, note: 'lisinopril 10mg',
    });
    const seen = captureProvider(gateway);

    await gateway.handleTestMessage('chat-1', 'how are things');

    // SAFETY.md exists on disk and is injected fresh; the turn did not throw despite no embeddings.
    expect(fs.readFileSync(path.join(workspace, 'SAFETY.md'), 'utf8')).toContain('lisinopril');
    expect(lastSystem(seen)).toContain('lisinopril');
  });

  it('fails closed on the next live turn after SAFETY publication fails', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);
    const renderSpy = jest.spyOn(SafetyView.prototype, 'render').mockRejectedValueOnce(new Error('render failure'));
    try {
      const result = await registryOf().execute('ledger_record', {
        entity: 'penicillin', type: 'allergy', fields: { reaction: 'hives' }, note: 'penicillin allergy',
      });
      expect(result.isError).toBe(true);
      expect(fs.existsSync(path.join(workspace, '.state', 'safety-view.dirty'))).toBe(true);

      const providerCallsBefore = seen.length;
      const reply = await gateway.handleTestMessage('chat-1', 'what should I know about antibiotics');
      expect(reply).toContain("trouble right now");
      expect(seen.length).toBe(providerCallsBefore);
    } finally {
      renderSpy.mockRestore();
    }
  });
});
