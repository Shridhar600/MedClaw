// W-C/D hostile-panel fix pass — gateway-layer regressions (CAP / BL / REC).
// Each test was proven RED on p1-memory-core @ cbf6c40 before its fix landed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';

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

describe('W-C/D fix pass — CAP: emergency + onboarding turns are losslessly captured', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-gw-'));
    workspace = path.join(tmpDir, 'workspace');
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function start(): Promise<void> {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();
    warn.mockRestore();
  }

  it('an EMERGENCY turn is captured before the canned-response early-return', async () => {
    await start();
    // Real onboarding flow is incomplete, so this hits the emergency check FIRST.
    await gateway.handleTestMessage('chat-1', 'I have severe chest pain right now');

    const narrative = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    expect(narrative).toContain('I have severe chest pain right now');
  });

  it('an ONBOARDING turn is captured before its early-return', async () => {
    await start();
    await gateway.handleTestMessage('chat-1', 'My name is Arjun and I take metformin daily');

    const narrative = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    expect(narrative).toContain('metformin');
  });
});

describe('W-C/D fix pass — REC: boot-time SAFETY reconciliation', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-rec-'));
    workspace = path.join(tmpDir, 'workspace');
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('start() re-renders SAFETY.md from the ledger (self-healing after crash/corruption)', async () => {
    // Seed the ledger BEFORE boot — simulates a crash between write and render,
    // or any drift where SAFETY.md is stale/missing while the ledger has facts.
    const ledgerDir = path.join(workspace, 'ledger');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(
      path.join(ledgerDir, 'medications.md'),
      [
        '## metformin',
        '### v1 (active)',
        '- provenance: user (0.90) · ',
        '- captured_at: 2026-08-20T10:00:00.000Z',
        '- safety_relevant: true',
        '- created_at: 2026-08-20T10:00:00.000Z',
        '- dose: 500mg',
        '',
      ].join('\n'),
    );

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();
    warn.mockRestore();

    const safety = fs.readFileSync(path.join(workspace, 'SAFETY.md'), 'utf8');
    expect(safety).toContain('## Medications');
    expect(safety).toContain('metformin');
  });
});

describe('W-C/D fix pass — BL: KNEE-01 back-link written on the CONFIRM path', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wcd-bl-'));
    workspace = path.join(tmpDir, 'workspace');
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => (gateway as any).agentLoop.registry;

  it('ledger_update confirm appends the `## Ledger writes` cross-anchor', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();
    warn.mockRestore();

    const byName = (n: string) => registryOf().getAvailable().find((t: { name: string }) => t.name === n);

    await byName('ledger_record').execute({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' } });
    const rec = await byName('ledger_record').execute({ entity: 'warfarin', type: 'medication', fields: { dose: '10mg' } });
    const tokenId = (rec.content[0].text.match(/[0-9a-f]{12}/) ?? [])[0]!;
    const upd = await byName('ledger_update').execute({ tokenId, confirm: true });
    expect(upd.isError).toBeFalsy();

    const narrative = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    expect(narrative).toContain('## Ledger writes');
    // The ANCHOR OF THE CONFIRMED WRITE (v2) must exist — the v1 anchor comes
    // from the initial applied record and proves nothing about the confirm path.
    expect(narrative).toMatch(/warfarin → warfarin@v2\b/);
  });

  it('ledger_update dispute resolution ALSO writes the back-link', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();
    warn.mockRestore();

    const byName = (n: string) => registryOf().getAvailable().find((t: { name: string }) => t.name === n);

    await byName('ledger_record').execute({ entity: 'migraine', type: 'condition', fields: { frequency: 'weekly' } });
    const rec = await byName('ledger_record').execute({ entity: 'migraine', type: 'condition', fields: { frequency: 'daily' } });
    const tokenId = (rec.content[0].text.match(/[0-9a-f]{12}/) ?? [])[0]!;
    // Disputed result renders the token id too; resolve with winningVersion=2 (the new claim).
    const upd = await byName('ledger_update').execute({ tokenId, confirm: true, winningVersion: 2 });
    expect(upd.isError).toBeFalsy();

    const narrative = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    // The dispute RESOLUTION's winner (v2) gets its own back-link.
    expect(narrative).toMatch(/migraine → migraine@v2\b/);
  });
});
