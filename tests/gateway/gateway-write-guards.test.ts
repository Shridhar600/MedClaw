import * as fs from 'fs';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import type { OwnerAdmissionService } from '../../src/profiles';
import { TEST_OWNER_ID, fixtureOwner, ownerSelection } from '../helpers/test-config';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';
import { composeOwnerAuthority } from '../../src/runtime/owner-authority';
import type { ProfileId } from '../../src/profiles/types';
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

const today = (): string => new Date().toISOString().slice(0, 10);

describe('emergency + onboarding turns are losslessly captured', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-gw-');
    workspace = fixtureOwner(tmpDir).workspace;
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let admission: OwnerAdmissionService;

  async function bindOwnerChat(chatId: string): Promise<void> {
    const bound = await bindOwnerFixture(
      fixtureOwner(tmpDir).ownerRecord,
      TEST_OWNER_ID,
      chatId,
      { channel: 'local', userId: 'local' },
    );
    admission = bound.admission;
  }

  async function start(options: { bindChatId?: string; unpairedRecord?: boolean } = {}): Promise<void> {
    if (options.bindChatId) {
      await bindOwnerChat(options.bindChatId);
    } else if (options.unpairedRecord) {
      const authority = composeOwnerAuthority({
        ownerId: TEST_OWNER_ID as ProfileId,
        ownerPaths: { ownerRecord: fixtureOwner(tmpDir).ownerRecord },
      });
      await authority.admission.initialize();
      admission = authority.admission;
    }
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    gateway = new Gateway(makeConfig(tmpDir), {
      admission,
      ownerId: TEST_OWNER_ID as ProfileId,
    });
    await gateway.start();
    warn.mockRestore();
  }

  it('the OWNER chat\'s EMERGENCY turn is captured before the canned-response early-return', async () => {
    await start({ bindChatId: 'chat-1' });

    // Real onboarding flow is incomplete, so this hits the emergency check FIRST.
    await gateway.handleTestMessage('chat-1', 'I have severe chest pain right now');

    const narrative = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    expect(narrative).toContain('I have severe chest pain right now');
  });

  it('an UNPAIRED chat\'s emergency text gets canned guidance and is never captured', async () => {
    await start({ unpairedRecord: true });
    const sent: string[] = [];
    (gateway as unknown as { channel?: unknown }).channel = undefined;

    await gateway.handleTestMessage('stranger-chat', 'I have severe chest pain right now');

    expect(fs.existsSync(path.join(workspace, 'memory', `${today()}.md`))).toBe(false);
    expect(sent).toEqual([]);
  });

  it('an ONBOARDING turn is captured before its early-return', async () => {
    await start({ bindChatId: 'chat-1' });
    await gateway.handleTestMessage('chat-1', 'My name is Arjun and I take metformin daily');

    const narrative = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    expect(narrative).toContain('metformin');
  });
});

describe('boot-time SAFETY reconciliation', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;
  let admission: OwnerAdmissionService;

  /** Admission is required, so even a boot that only reconciles SAFETY.md holds a real bound owner. */
  async function bindOwnerChat(chatId: string): Promise<void> {
    const bound = await bindOwnerFixture(
      fixtureOwner(tmpDir).ownerRecord, TEST_OWNER_ID, chatId, { channel: 'local', userId: 'local' },
    );
    admission = bound.admission;
  }

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-rec-');
    workspace = fixtureOwner(tmpDir).workspace;
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('start re-renders SAFETY.md from the ledger (self-healing after crash/corruption)', async () => {
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
    // Admission is required, so a boot that reconciles SAFETY.md must hold a real bound owner.
    await bindOwnerChat(CHAT_BINDING);
    gateway = new Gateway(makeConfig(tmpDir), { admission, ownerId: TEST_OWNER_ID as ProfileId });
    await gateway.start();
    warn.mockRestore();

    const safety = fs.readFileSync(path.join(workspace, 'SAFETY.md'), 'utf8');
    expect(safety).toContain('## Medications');
    expect(safety).toContain('metformin');
  });
});

describe('back-link written on the CONFIRM path', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let workspace: string;
  let admission: OwnerAdmissionService;

  async function bindOwnerChat(chatId: string): Promise<void> {
    const bound = await bindOwnerFixture(
      fixtureOwner(tmpDir).ownerRecord, TEST_OWNER_ID, chatId, { channel: 'local', userId: 'local' },
    );
    admission = bound.admission;
  }

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-bl-');
    workspace = fixtureOwner(tmpDir).workspace;
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => ownerTools((gateway as any).agentLoop.registry);

  it('ledger_update confirm appends the `## Ledger writes` cross-anchor', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await bindOwnerChat(CHAT_BINDING);
    gateway = new Gateway(makeConfig(tmpDir), { admission, ownerId: TEST_OWNER_ID as ProfileId });
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
    expect(narrative).toMatch(/warfarin → warfarin@v2\b/);
  });

  it('ledger_update dispute resolution ALSO writes the back-link', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    await gateway.start();
    warn.mockRestore();

    const byName = (n: string) => registryOf().getAvailable().find((t: { name: string }) => t.name === n);

    await byName('ledger_record').execute({ entity: 'migraine', type: 'condition', fields: { frequency: 'weekly' } });
    const rec = await byName('ledger_record').execute({ entity: 'migraine', type: 'condition', fields: { frequency: 'daily' } });
    const tokenId = (rec.content[0].text.match(/[0-9a-f]{12}/) ?? [])[0]!;
    const upd = await byName('ledger_update').execute({ tokenId, confirm: true, winningVersion: 2 });
    expect(upd.isError).toBeFalsy();

    const narrative = fs.readFileSync(path.join(workspace, 'memory', `${today()}.md`), 'utf8');
    expect(narrative).toMatch(/migraine → migraine@v2\b/);
  });
});
