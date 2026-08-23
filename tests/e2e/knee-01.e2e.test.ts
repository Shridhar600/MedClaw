// P1 E2E — KNEE-01 through the REAL composition root (specs/09 KNEE-01; plan Task 14.5, specs/16 §6.4).
//
// Drives the real `Gateway.handleTestMessage` (the in-process mirror of handleMessage — there is no CLI
// channel in P1; §6.4's DAD-01/PLAT-02 legs are already covered by P0 profile tests, so P1's NEW E2E is
// KNEE-01). A scripted provider stub feeds canned tool-calls into the real AgentLoop → real tool registry
// → the wired ledger/narrative/SAFETY stores at the resolved profile workspace. Hermetic (G11): telegram
// off; providers point at unreachable local endpoints so runBootHealthchecks warns-and-continues; the
// one-time indexAll on the empty temp profile degrades to keyword-only. No network, no real model.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';

const today = (): string => new Date().toISOString().slice(0, 10);

/** A deterministic provider that replays a fixed response script (tool-calls then a final text). */
class ScriptedProvider implements LLMProvider {
  readonly modelName = 'scripted-e2e';
  private i = 0;
  constructor(private readonly script: LLMResponse[]) {}
  async chat(): Promise<LLMResponse> {
    return this.script[Math.min(this.i++, this.script.length - 1)];
  }
  async embed(): Promise<number[]> {
    return new Array(768).fill(0);
  }
}

function makeConfig(tmpDir: string): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
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

const KNEE_01_SCRIPT: LLMResponse[] = [
  { type: 'tool_call', toolCalls: [{ id: 'c1', name: 'ledger_record', arguments: { entity: 'knee-injury', type: 'condition', fields: { status: 'active' }, source: 'user', note: 'injured my knee on the trek, limping' } }] },
  { type: 'tool_call', toolCalls: [{ id: 'c2', name: 'ledger_record', arguments: { entity: 'limping', type: 'symptom', fields: { related_to: 'knee-injury' }, source: 'user', note: 'limping' } }] },
  { type: 'tool_call', toolCalls: [{ id: 'c3', name: 'ledger_record', arguments: { entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg PRN' }, source: 'user', note: 'taking ibuprofen 400mg as needed' } }] },
  { type: 'text', text: 'Sorry about your knee — rest, ice, and ibuprofen as needed. If it worsens, see a clinician.' },
];

describe('KNEE-01 E2E (real Gateway.handleTestMessage)', () => {
  let tmpDir: string;
  let workspace: string;
  let gateway: Gateway;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-knee-e2e-'));
    workspace = path.join(tmpDir, 'workspace');
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures the injury across both lanes with cross-anchors; SAFETY excludes the transient injury', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await gateway.start();

    // Skip the deterministic onboarding machine and feed canned tool-calls to the REAL agent loop.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).handleOnboarding = async (): Promise<null> => null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop.provider = new ScriptedProvider(KNEE_01_SCRIPT);

    await gateway.handleTestMessage('owner-chat', "Hey, I injured my knee on the trek today. What should I do? I'm limping.");

    warn.mockRestore();
    errorLog.mockRestore();

    // Ledger lane — three type files written at the resolved profile workspace.
    expect(fs.readFileSync(path.join(workspace, 'ledger', 'conditions.md'), 'utf8')).toContain('knee-injury');
    expect(fs.readFileSync(path.join(workspace, 'ledger', 'symptoms.md'), 'utf8')).toContain('limping');
    expect(fs.readFileSync(path.join(workspace, 'ledger', 'medications.md'), 'utf8')).toContain('ibuprofen');

    // Narrative lane — raw user text (lossless capture hook) + the `## Ledger writes` cross-anchors.
    const day = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    expect(day).toContain('injured my knee on the trek');
    expect(day).toContain('## Ledger writes');
    for (const e of ['knee-injury', 'limping', 'ibuprofen']) expect(day).toContain(`${e} →`);

    // SAFETY.md must NOT list the transient, non-safety-relevant injury.
    const safety = fs.existsSync(path.join(workspace, 'SAFETY.md'))
      ? fs.readFileSync(path.join(workspace, 'SAFETY.md'), 'utf8')
      : '';
    expect(safety).not.toContain('knee-injury');
  });
});
