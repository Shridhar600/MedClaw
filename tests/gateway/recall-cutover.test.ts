import * as fs from 'fs';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { SafetyView } from '../../src/memcore';
import type { EffectiveConfig } from '../../src/config/types';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';
import { fixtureOwner, ownerSelection } from '../helpers/test-config';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';
import { makeTestTemp } from '../helpers/test-temp';
import { ownerTools } from '../helpers/owner-tools';

const CHAT_BINDING = 'chat-1';

function makeConfig(tmpDir: string): EffectiveConfig {
const owner = fixtureOwner(tmpDir);
  return {
  schemaVersion: 2,
  ...ownerSelection(owner),
    providers: {
      main: { type: 'ollama', model: 'kimi-k2.5:cloud', baseUrl: 'http://localhost:11434/v1' },
      medical: { type: 'ollama', model: 'medgemma', baseUrl: 'http://localhost:11434/v1' },
      embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: owner.workspace,
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: owner.storePath,
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: owner.auditLogPath },
      policy: {
        quietHours: { enabled: true, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 60,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 15 },
  };
}

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
  const gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await gateway.start();
  warn.mockRestore();
  log.mockRestore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway.runtimeInstance!.turnCoordinator as any).handleOnboarding = async (): Promise<null> => null;
  return gateway;
}

describe('Gateway — per-turn recall + v2 assembly cutover', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-recall-cutover-');
    workspace = fixtureOwner(tmpDir).workspace;
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => ownerTools((gateway as any).agentLoop.registry);
  const lastSystem = (seen: Message[][]): string => String(seen[seen.length - 1][0].content);

  it('re-renders SAFETY into the running prompt after a mid-session mutation, no restart', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);

    await gateway.handleTestMessage('chat-1', 'hello there');
    expect(lastSystem(seen)).not.toContain('penicillin');

    // Mid-session: record a safety-relevant allergy, so the next render must include it.
    const res = await registryOf().execute('ledger_record', {
      entity: 'penicillin', type: 'allergy', fields: { reaction: 'hives' }, note: 'penicillin allergy, hives',
    });
    expect(res.isError).toBeFalsy();

    await gateway.handleTestMessage('chat-1', 'anything I should know before a new antibiotic');
    // The very next turn's prompt reflects the new SAFETY content WITHOUT any restart.
    expect(lastSystem(seen)).toContain('penicillin');
  });

  it('injects Stage-1 active-ledger one-liners on a heartbeat turn but not full MEMORY', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);

    await registryOf().execute('ledger_record', {
      entity: 'knee-injury', type: 'condition', fields: { status_note: 'MCL sprain, avoid heavy leg loading' },
      note: 'knee MCL sprain',
    });

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

  it('reports per-turn prompt mode in /status when the recall path is wired', async () => {
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

  it('SELF-HEALS on the next live turn after a TRANSIENT SAFETY publication failure', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);
    const renderSpy = jest.spyOn(SafetyView.prototype, 'render').mockRejectedValueOnce(new Error('render failure'));
    try {
      const result = await registryOf().execute('ledger_record', {
        entity: 'penicillin', type: 'allergy', fields: { reaction: 'hives' }, note: 'penicillin allergy',
      });
      expect(result.isError).toBeFalsy();
      expect(fs.existsSync(path.join(workspace, '.state', 'safety-view.dirty'))).toBe(true);

      const reply = await gateway.handleTestMessage('chat-1', 'what should I know about antibiotics');
      expect(reply).not.toContain('trouble right now');
      expect(fs.readFileSync(path.join(workspace, 'SAFETY.md'), 'utf8')).toContain('penicillin');
      expect(lastSystem(seen)).toContain('penicillin');
    } finally {
      renderSpy.mockRestore();
    }
  });

  it('STILL fails closed on the next live turn when SAFETY publication fails PERSISTENTLY', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);
    const renderSpy = jest.spyOn(SafetyView.prototype, 'render').mockRejectedValue(new Error('render failure'));
    try {
      const result = await registryOf().execute('ledger_record', {
        entity: 'penicillin', type: 'allergy', fields: { reaction: 'hives' }, note: 'penicillin allergy',
      });
      expect(result.isError).toBeFalsy();
      expect(fs.existsSync(path.join(workspace, '.state', 'safety-view.dirty'))).toBe(true);

      const providerCallsBefore = seen.length;
      const reply = await gateway.handleTestMessage('chat-1', 'what should I know about antibiotics');
      expect(reply).toContain('trouble right now');
      expect(seen.length).toBe(providerCallsBefore);
    } finally {
      renderSpy.mockRestore();
    }
  });
});

describe('Gateway — current facts follow the ledger', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-ledger-truth-');
    workspace = fixtureOwner(tmpDir).workspace;
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => ownerTools((gateway as any).agentLoop.registry);
  const lastSystem = (seen: Message[][]): string => String(seen[seen.length - 1][0].content);
  const ledgerFile = (name: string): string => path.join(workspace, 'ledger', name);

  it('a hand edit of the ledger reaches the next reply', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);
    await registryOf().execute('ledger_record', { entity: 'daily-walk', type: 'goal', fields: { target: '5000 steps' } });
    await gateway.handleTestMessage('chat-1', 'hello', 'm1');
    expect(lastSystem(seen)).toContain('5000 steps');

    const file = ledgerFile('goals.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('5000 steps', '9000 steps'));
    await gateway.handleTestMessage('chat-1', 'hello again', 'm2');

    expect(lastSystem(seen)).toContain('9000 steps');
    expect(lastSystem(seen)).not.toContain('5000 steps');
  });

  it('a damaged ledger file is flagged in the reply context and refuses changes until repaired', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);
    await registryOf().execute('ledger_record', { entity: 'metformin', type: 'medication', fields: { dose: '500mg' } });
    const file = ledgerFile('medications.md');
    fs.appendFileSync(file, '## warfarin\n### v1 (active)\n- dose 5mg\n');
    const damaged = fs.readFileSync(file, 'utf8');

    await gateway.handleTestMessage('chat-1', 'what am I taking?', 'm1');
    expect(lastSystem(seen)).toMatch(/medications\.md[^\n]*damaged/);
    expect(lastSystem(seen)).toContain('metformin');

    const change = await registryOf().execute('ledger_record', { entity: 'metformin', type: 'medication', fields: { dose: '1000mg' } });
    expect(change.isError).toBe(true);
    expect(change.content[0].text).toMatch(/damaged/);
    await gateway.handleTestMessage('chat-1', 'and now?', 'm2');

    expect(fs.readFileSync(file, 'utf8')).toBe(damaged);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('medications.md.corrupt-'))).toHaveLength(1);
  });

  it('an unreadable allergy file is named in SAFETY.md instead of silently dropping the allergies', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);
    await registryOf().execute('ledger_record', { entity: 'penicillin', type: 'allergy', fields: { reaction: 'hives' } });
    await gateway.handleTestMessage('chat-1', 'hello', 'm1');
    expect(lastSystem(seen)).toContain('penicillin');

    fs.writeFileSync(ledgerFile('allergies.md'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    await gateway.handleTestMessage('chat-1', 'can I take amoxicillin?', 'm2');

    const safety = fs.readFileSync(path.join(workspace, 'SAFETY.md'), 'utf8');
    expect(safety).toMatch(/allergies\.md[^\n]*damaged/);
    expect(lastSystem(seen)).toMatch(/allergies\.md[^\n]*damaged/);
  });
});

describe('Gateway — onboarding seeds the health record', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-onboarding-seed-');
    workspace = fixtureOwner(tmpDir).workspace;
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('meds, allergies and conditions given at setup reach SAFETY.md and the next reply', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await gateway.start();
    try {
      const answers = [
        'hi', 'Asha', '54', 'yes', 'type 2 diabetes', 'Metformin 500mg twice daily, vitamin D3 1000 IU',
        'penicillin (hives) and peanuts', 'walk daily', 'morning reminders', 'confirm',
      ];
      let reply = '';
      for (const [i, text] of answers.entries()) reply = await gateway.handleTestMessage('chat-1', text, `o${i}`);
      expect(reply).toMatch(/onboarding is complete/i);

      const safety = fs.readFileSync(path.join(workspace, 'SAFETY.md'), 'utf8');
      for (const entity of ['penicillin', 'peanuts', 'metformin', 'vitamin d3']) expect(safety).toContain(entity);
      expect(fs.readFileSync(path.join(workspace, 'ledger', 'medications.md'), 'utf8')).toContain('500mg twice daily');
      expect(fs.readFileSync(path.join(workspace, 'ledger', 'allergies.md'), 'utf8')).toContain('hives');

      const seen = captureProvider(gateway);
      await gateway.handleTestMessage('chat-1', 'how am I doing?', 'after');
      expect(lastSystemOf(seen)).toContain('type 2 diabetes');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('"none" answers record nothing', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await gateway.start();
    try {
      const answers = ['hi', 'Ravi', '30', 'yes', 'none', 'no', 'none known', 'sleep better', 'none', 'confirm'];
      for (const [i, text] of answers.entries()) await gateway.handleTestMessage('chat-1', text, `o${i}`);
      for (const file of ['conditions.md', 'medications.md', 'allergies.md']) {
        expect(fs.existsSync(path.join(workspace, 'ledger', file))).toBe(false);
      }
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

const lastSystemOf = (seen: Message[][]): string => String(seen[seen.length - 1][0].content);

describe('Gateway — secrets in inbound messages', () => {
  const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
  let tmpDir: string;
  let gateway: Gateway;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-inbound-secret-');
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const filesContaining = (needle: string): string[] => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full).includes(needle)) hits.push(path.relative(tmpDir, full));
      }
    };
    walk(tmpDir);
    return hits;
  };

  it('refuses a chat message carrying an API key without calling the model or saving it', async () => {
    gateway = await startGateway(tmpDir);
    const seen = captureProvider(gateway);

    const reply = await gateway.handleTestMessage('chat-1', `my openai key is ${SECRET}`, 'm1');

    expect(reply).toMatch(/password or API key/);
    expect(seen).toHaveLength(0);
    expect(filesContaining(SECRET)).toEqual([]);
  });

  it('refuses a failed-upload caption carrying an API key without saving it', async () => {
    gateway = await startGateway(tmpDir);
    let reply = '';
    await gateway.deliverMessage({
      chatId: 'chat-1', userId: 'local', channel: 'local', chatType: 'private', eventId: 'local:chat-1:m2',
      messageId: 'm2', text: `report attached, token=${SECRET}`, mediaError: 'Failed to download uploaded file report.pdf',
    } as never, async (text) => { reply = text; });

    expect(reply).toMatch(/password or API key/);
    expect(filesContaining(SECRET)).toEqual([]);
  });

  it('refuses an onboarding answer carrying an API key without saving it', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await gateway.start();
    try {
      const first = await gateway.handleTestMessage('chat-1', 'hi', 'm1');
      expect(first).not.toMatch(/password or API key/);
      const reply = await gateway.handleTestMessage('chat-1', SECRET, 'm2');
      expect(reply).toMatch(/password or API key/);
      expect(filesContaining(SECRET)).toEqual([]);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
