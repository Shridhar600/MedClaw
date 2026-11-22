
import * as fs from 'fs';
import * as path from 'path';
import { Api, Bot } from 'grammy';
import type { Chat, Message as TelegramMessage, Update, User } from 'grammy/types';
import { TelegramMediaSource } from '../../src/channels';
import * as healthcheck from '../../src/providers/healthcheck';

import { runCli } from '../../src/cli';
import { startDaemon, type DaemonHandle } from '../../src/index';
import { Gateway } from '../../src/gateway';
import type { DiagnosticEvent, DiagnosticSink } from '../../src/ports/diagnostics';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';
import type { IncomingMessage } from '../../src/channels/types';
import { CryptoPairingCodePort, FileOwnerStatePort, DirectoryLease, FsMediaStager, writeConfigDocument } from '../../src/runtime';
import { InstallationService } from '../../src/runtime/installation';
import { OwnerAdmissionService, asProfileId } from '../../src/profiles';
import type { TransportIdentity } from '../../src/ports/owner-state';
import type { MediaSourcePort, MediaStageResult } from '../../src/ports/media-source';
import { systemClock } from '../../src/ports/defaults';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { resolveOwnerPaths } from '../../src/profiles';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import type { Clock, PairingCodePort } from '../../src/ports';
import { EMERGENCY_RESPONSE } from '../../src/safety/emergency-detector';

jest.mock('../../src/providers/healthcheck', () => ({
  ...jest.requireActual('../../src/providers/healthcheck'),
  checkSystemReadiness: jest.fn(async () => ({
    providers: ['main provider', 'medical provider', 'embeddings provider'].map(label => ({ label, ready: true, checked: true, status: 'ok', details: [], warnings: [] })),
    telegram: { label: 'telegram', ready: true, checked: true, status: 'ok', details: [], warnings: [] },
  })),
}));

/** A scripted provider. Deterministic, in-process, and never touches the network. */
class ScriptedProvider implements LLMProvider {
  readonly modelName = 'e2e-scripted';
  readonly chatCalls: LLMResponse[] = [];
  constructor(private readonly script: LLMResponse[]) {}
  async chat(): Promise<LLMResponse> {
    const next = this.script[Math.min(this.chatCalls.length, this.script.length - 1)];
    this.chatCalls.push(next);
    return next;
  }
  async embed(): Promise<number[]> {
    return new Array(768).fill(0);
  }
}

function textResponse(content: string): LLMResponse {
  return { type: 'text', text: content };
}

/** The paths a real setup run would derive. Nothing here is pre-created. */
interface SpineTarget {
  configPath: string;
  baseDir: string;
  ownerId: string;
  ownerRecord: string;
  workspace: string;
  workspaceLease: string;
}

const OWNER_CHAT = 'owner-chat';
const OWNER_USER = 'owner-user';


function telegramMessage(
  chatId: string,
  userId: string,
  messageId: string,
  text: string,
): IncomingMessage {
  return {
    channel: 'telegram',
    chatType: 'private',
    eventId: `telegram:${chatId}:${messageId}`,
    chatId,
    userId,
    messageId,
    text,
  };
}

function identityFor(chatId: string, userId: string, messageId: string): TransportIdentity {
  return {
    channel: 'telegram',
    chatId,
    userId,
    chatType: 'private',
    eventId: `telegram:${chatId}:${messageId}`,
  };
}

/** Snapshot every file in this small, synthetic installation, including new-file detection. */
function syntheticBytes(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files[path.relative(dir, target)] = fs.readFileSync(target).toString('hex');
      else throw new Error('unexpected link in synthetic fixture');
    }
  }
  visit(dir);
  return files;
}

function heldEvent(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('owner spine: setup -> daemon -> stranger refused -> pair -> owner turn -> restart', () => {
  let root: string;
  let fixture: SpineTarget;

  beforeEach(() => {
    root = makeTestTemp('spine');
    const baseDir = path.join(root, 'state');
    const ownerId = 'default';
    const ownerPaths = resolveOwnerPaths(baseDir, asProfileId(ownerId)!);
    fixture = {
      configPath: path.join(root, 'config.json'),
      baseDir,
      ownerId,
      ownerRecord: ownerPaths.ownerRecord,
      workspace: ownerPaths.workspace,
      workspaceLease: ownerPaths.workspaceLease,
    };
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  async function cli(argv: string[]): Promise<{ code: number; output: string }> {
    let output = '';
    const code = await runCli(argv, {
      stdout: (text) => { output += text; },
      stderr: (text) => { output += text; },
    });
    return { code, output };
  }

  /** The real non-interactive setup an operator would run. */
  function setup(telegramToken?: string): Promise<{ code: number; output: string }> {
    return cli([
      'onboard',
      '--yes',
      '--config', fixture.configPath,
      '--state-root', fixture.baseDir,
      '--owner-id', fixture.ownerId,
      '--provider', 'ollama',
      '--telegram-enabled', telegramToken ? 'true' : 'false',
      ...(telegramToken ? ['--telegram-token', telegramToken] : []),
      '--timezone', 'UTC',
      '--heartbeats-enabled', 'false',
    ]);
  }

  function admissionFor(diagnostics?: DiagnosticSink, clock: Clock = systemClock, codes: PairingCodePort = new CryptoPairingCodePort()): OwnerAdmissionService {
    return new OwnerAdmissionService({
      store: new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId),
      codes,
      clock,
      expectedOwnerId: fixture.ownerId,
      ...(diagnostics ? { diagnostics } : {}),
    });
  }

  async function bootDaemon(
    provider: LLMProvider,
    /** When supplied, the real boot reports its outcomes through the closed diagnostic contract. */
    diagnostics?: DiagnosticSink,
    /** When supplied, admitted owner media is served from this source. */
    mediaSource?: MediaSourcePort,
    controls: { clock?: Clock; codes?: PairingCodePort; createProvider?: () => LLMProvider } = {},
  ): Promise<DaemonHandle> {
    const config = await loadRuntimeConfig({ configPath: fixture.configPath });
    return startDaemon({
      services: new InstallationService(new DirectoryLease()),
      configPath: fixture.configPath,
      homeDir: root,
      createGateway: () => {
        const gateway = new Gateway(config, {
          admission: admissionFor(diagnostics, controls.clock, controls.codes),
          ownerId: asProfileId(fixture.ownerId)!,
          createProvider: controls.createProvider ?? (() => provider),
          ...(diagnostics ? { diagnostics } : {}),
          ...(mediaSource ? { mediaSource } : {}),
        });
        return gateway;
      },
    });
  }

  it('actual Telegram updates pair, capture once, restart, consume owner media and refuse foreign effects through the default daemon', async () => {
    const token = '123456789:C10_synthetic_bot_token';
    expect((await setup(token)).code).toBe(0);
    const issued = await cli(['--config', fixture.configPath, 'pairing', 'issue']);
    expect(issued.code).toBe(0);
    const code = issued.output.match(/\b[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}\b/)?.[0];
    if (!code) throw new Error('CLI did not display the synthetic pairing code');
    const configBytes = fs.readFileSync(fixture.configPath);
    expect(JSON.parse(configBytes.toString())).toMatchObject({
      schemaVersion: 2, profiles: { baseDir: fixture.baseDir, defaultProfileId: 'default' },
      channels: { telegram: { enabled: true, botToken: token } },
    });
    expect(JSON.parse(fs.readFileSync(fixture.ownerRecord, 'utf8'))).toMatchObject({ ownerId: 'default', phase: 'unpaired' });
    const configLease = `${fixture.configPath}.lease`;
    for (const file of [fixture.configPath, fixture.ownerRecord]) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    for (const dir of [fixture.workspace, path.dirname(fixture.ownerRecord)]) expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    for (const lease of [configLease, fixture.workspaceLease]) expect(fs.existsSync(lease)).toBe(false);

    const ownerChat = 731001234, ownerUser = 731005678;
    const narrative = 'C10_first_health_marker I slept badly last night';
    const caption = 'C10_media_caption_marker Please keep this attachment with my sleep notes';
    const body = Buffer.from('C10_streamed_attachment_marker\nsynthetic sleep notes\n');
    const output: unknown[][] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map(method => jest.spyOn(console, method).mockImplementation((...args: unknown[]) => { output.push(args); }));
    const bots: Bot[] = [];
    const polling = new Map<Bot, { promise: Promise<void>; release: () => void }>();
    const registrations = jest.spyOn(Bot.prototype, 'on'); // Call through actual middleware registration.
    const start = jest.spyOn(Bot.prototype, 'start').mockImplementation(function (this: Bot): Promise<void> {
      this.botInfo = { id: 731009999, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false, has_topics_enabled: false, allows_users_to_create_topics: false };
      this.api.config.use(async () => { throw new Error('Unexpected Telegram API call under test'); });
      const lifecycle = heldEvent();
      polling.set(this, lifecycle); bots.push(this);
      return lifecycle.promise;
    });
    const stop = jest.spyOn(Bot.prototype, 'stop').mockImplementation(async function (this: Bot): Promise<void> {
      const lifecycle = polling.get(this);
      if (!lifecycle) throw new Error('Stopped an unstarted test bot');
      lifecycle.release(); polling.delete(this);
    });
    const replies: { chat: string; text: string }[] = [];
    const send = jest.spyOn(Api.prototype, 'sendMessage').mockImplementation(async (chatId, text): Promise<TelegramMessage.TextMessage> => {
      replies.push({ chat: String(chatId), text });
      return { message_id: replies.length, date: 1780000000, chat: { id: Number(chatId), type: 'private', first_name: 'Synthetic' }, text };
    });
    const readiness = jest.mocked(healthcheck.checkSystemReadiness);
    readiness.mockClear();
    const prompts: string[] = [];
    let builds = 0, embeddings = 0, bodyReads = 0;
    const provider: LLMProvider = {
      modelName: 'telegram-scripted',
      chat: async messages => { prompts.push(JSON.stringify(messages)); return textResponse('owner turn accepted.'); },
      embed: async () => { embeddings += 1; return new Array(768).fill(0); },
    };
    const getFile = jest.fn(async (_id: string, signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(false);
      return { file_path: 'files/C10_transport_path_marker.txt', file_size: body.length };
    });
    const fetchBody = jest.fn(async (url: string, signal: AbortSignal): Promise<Response> => {
      expect(url).toBe(`https://api.telegram.org/file/bot${token}/files/C10_transport_path_marker.txt`);
      expect(signal.aborted).toBe(false);
      let offset = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller): void {
          if (offset === body.length) { controller.close(); return; }
          const next = Math.min(offset + 7, body.length);
          bodyReads += 1; controller.enqueue(body.subarray(offset, next)); offset = next;
        },
      }));
    });
    const source = new TelegramMediaSource({ token, api: { getFile }, fetchImpl: fetchBody });
    const boot = (): Promise<DaemonHandle> => startDaemon({ configPath: fixture.configPath, homeDir: root, externalIO: {
      createProvider: () => { builds += 1; return provider; }, mediaSource: source,
    } });
    let daemon: DaemonHandle | undefined;
    let messageId = 0;
    function update(payload: { text: string } | { caption: string; document: TelegramMessage.DocumentMessage['document'] } | { caption: string; photo: TelegramMessage.PhotoMessage['photo'] }, identity: { chat?: number; user?: number | null; group?: boolean } = {}): Update {
      messageId += 1;
      const chat: Chat = identity.group
        ? { id: identity.chat ?? ownerChat, type: 'group', title: 'Synthetic group' }
        : { id: identity.chat ?? ownerChat, type: 'private', first_name: 'Synthetic' };
      const from: User = { id: identity.user ?? ownerUser, is_bot: false, first_name: 'Synthetic' };
      const wire: Update = { update_id: messageId, message: { message_id: messageId, date: 1780000000, chat, from, ...payload } };
      if (identity.user !== null) return wire;
      const withoutSender: Partial<TelegramMessage> = { ...wire.message! };
      delete withoutSender.from;
      return { update_id: wire.update_id, message: withoutSender } as Update;
    }
    const document = (fileId: string): TelegramMessage.DocumentMessage['document'] => ({ file_id: fileId, file_unique_id: `${fileId}-unique`, file_name: 'C10_display_name_marker.txt', mime_type: 'text/plain', file_size: body.length });
    const dispatch = async (bot: Bot, wire: Update): Promise<{ chat: string; text: string }[]> => {
      const before = replies.length;
      await bot.handleUpdate(wire);
      return replies.slice(before);
    };
    const drain = async (): Promise<void> => {
      const runtime = daemon?.gateway.runtimeInstance;
      if (!runtime?.writeQueue || !runtime.sessions) throw new Error('Expected real owner runtime/stores');
      await runtime.drainBackgroundOperations(); await runtime.writeQueue.drain();
    };
    const calls = (): number[] => [builds, prompts.length, embeddings, getFile.mock.calls.length, fetchBody.mock.calls.length, bodyReads, readiness.mock.calls.length];
    const assertRegistered = (bot: Bot): void => {
      for (const event of ['message:text', 'message:document', 'message:photo']) {
        const found = registrations.mock.calls.some((args, index) => registrations.mock.contexts[index] === bot && args[0] === event && typeof args[1] === 'function');
        if (!found) throw new Error(`Actual channel did not register ${event}`);
      }
    };
    try {
      daemon = await boot();
      expect(bots).toHaveLength(1); const firstBot = bots[0]; assertRegistered(firstBot);
      expect(daemon.gateway.servesPairingOnly).toBe(true);
      expect(daemon.gateway.runtimeInstance).toBeUndefined();
      for (const lease of [configLease, fixture.workspaceLease]) expect(fs.statSync(lease).mode & 0o777).toBe(0o700);
      const beforeStranger = syntheticBytes(fixture.workspace), beforeCalls = calls();
      const stranger = await dispatch(firstBot, update({ text: 'C10_unpaired_stranger_marker hello' }, { chat: 731002222, user: 731003333 }));
      expect(stranger).toHaveLength(1); expect(stranger[0].chat).toBe('731002222');
      expect(stranger[0].text).toMatch(/pairing code/i);
      const afterStranger = syntheticBytes(fixture.workspace);
      delete beforeStranger['.state/owner-access.json']; delete afterStranger['.state/owner-access.json'];
      expect(afterStranger).toEqual(beforeStranger); expect(calls()).toEqual(beforeCalls);
      expect(builds).toBe(0); expect(daemon.gateway.runtimeInstance).toBeUndefined();

      expect(await dispatch(firstBot, update({ text: code }))).toEqual([{ chat: String(ownerChat), text: 'Pairing complete. This chat is now connected to the owner.' }]);
      const binding = fs.readFileSync(fixture.ownerRecord);
      expect(JSON.parse(binding.toString())).toMatchObject({ ownerId: 'default', phase: 'bound', binding: { channel: 'telegram', chatId: String(ownerChat), senderId: String(ownerUser), pairingEventId: `telegram:${ownerChat}:2` } });
      expect(binding.toString()).not.toContain(code);
      expect(daemon.gateway.runtimeInstance).toBeUndefined(); expect(calls()).toEqual(beforeCalls);
      const first = await dispatch(firstBot, update({ text: narrative }));
      expect(first).toHaveLength(1); expect(first[0].chat).toBe(String(ownerChat));
      expect(first[0].text).toMatch(/personal health companion|before we start/i);
      expect(daemon.gateway.servesPairingOnly).toBe(false);
      expect(daemon.gateway.runtimeInstance!.workspace).toBe(fixture.workspace);
      expect((await dispatch(firstBot, update({ text: 'skip' })))[0].text).toMatch(/skipped|onboarding/i);
      const turn = await dispatch(firstBot, update({ text: 'C10_after_onboarding_marker I walked today' }));
      expect(turn).toHaveLength(1); expect(turn[0]).toMatchObject({ chat: String(ownerChat), text: expect.stringContaining('owner turn accepted.') });
      expect(prompts.length).toBeGreaterThan(0); await drain();
      const saved = syntheticBytes(fixture.workspace);
      const narrativeFiles = Object.entries(saved).filter(([file]) => file.startsWith('memory/') && file.endsWith('.md'));
      const archives = Object.entries(saved).filter(([file]) => file.includes('sessions/') && file.endsWith('.jsonl'));
      expect(narrativeFiles.map(([, hex]) => Buffer.from(hex, 'hex').toString()).join('\n').split(narrative)).toHaveLength(2);
      const userArchive = archives.flatMap(([, hex]) => Buffer.from(hex, 'hex').toString().trim().split('\n').map(line => JSON.parse(line))).filter(entry => entry.role === 'user');
      expect(userArchive.filter(entry => entry.content === narrative)).toHaveLength(1);
      for (const [file] of [...narrativeFiles, ...archives]) expect(fs.statSync(path.join(fixture.workspace, file)).mode & 0o777).toBe(0o600);
      const capturedText = [...narrativeFiles, ...archives].map(([, hex]) => Buffer.from(hex, 'hex').toString()).join('\n');
      expect(capturedText).not.toContain(code); expect(prompts.join('\n')).not.toContain(code);
      await daemon.shutdown(); daemon = undefined;
      expect(polling.size).toBe(0); expect(stop).toHaveBeenCalledTimes(1);
      for (const lease of [configLease, fixture.workspaceLease]) expect(fs.existsSync(lease)).toBe(false);

      daemon = await boot();
      expect(bots).toHaveLength(2); const rebootBot = bots[1]; expect(rebootBot).not.toBe(firstBot); assertRegistered(rebootBot);
      expect(daemon.gateway.servesPairingOnly).toBe(false);
      expect(daemon.gateway.runtimeInstance!.sessions!.getHistory(String(ownerChat))).toContainEqual({ role: 'user', content: narrative });
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
      for (const [file, hex] of narrativeFiles) expect(fs.readFileSync(path.join(fixture.workspace, file)).toString('hex')).toBe(hex);
      const priorPrompts = prompts.length;
      const mediaReply = await dispatch(rebootBot, update({ caption, document: document('C10_owner_file_marker') }));
      await drain();
      expect(getFile).toHaveBeenCalledTimes(1); expect(getFile.mock.calls[0][0]).toBe('C10_owner_file_marker');
      expect(fetchBody).toHaveBeenCalledTimes(1); expect(bodyReads).toBeGreaterThan(1);
      expect(prompts.length).toBeGreaterThan(priorPrompts);
      const mediaPrompt = prompts.slice(priorPrompts).join('\n');
      expect(mediaPrompt).toContain(caption);
      const relative = /Uploaded media path \(relative to workspace\): (reports\/[^\s"\\]+)/.exec(mediaPrompt)?.[1];
      if (!relative) throw new Error('Accepted media did not reach the real provider with an adopted path');
      const adopted = path.resolve(fixture.workspace, relative);
      expect(adopted.startsWith(path.join(fixture.workspace, 'reports') + path.sep)).toBe(true);
      expect(fs.readFileSync(adopted)).toEqual(body); expect(fs.statSync(adopted).mode & 0o777).toBe(0o600);
      expect(mediaReply).toHaveLength(1); expect(mediaReply[0]).toMatchObject({ chat: String(ownerChat), text: expect.stringContaining('owner turn accepted.') });
      expect(daemon.gateway.runtimeInstance!.sessions!.getHistory(String(ownerChat))).toContainEqual({ role: 'user', content: expect.stringContaining(`${caption}\n\nUploaded media path (relative to workspace): ${relative}`) });
      const staging = path.join(fixture.workspace, '.state', 'media-staging');
      expect(fs.statSync(staging).mode & 0o777).toBe(0o700); expect(fs.readdirSync(staging)).toEqual([]);
      expect(fs.readdirSync(path.join(fixture.workspace, 'reports'))).toEqual([path.basename(adopted)]);

      const denied = [
        update({ caption: 'C10_denied_sender_marker', document: document('C10_denied_file_marker') }, { user: 731004444 }),
        update({ caption: 'C10_denied_group_marker', photo: [{ file_id: 'C10_denied_photo_marker', file_unique_id: 'photo-unique', width: 10, height: 10, file_size: body.length }] }, { group: true }),
        update({ caption: 'C10_missing_sender_marker', document: document('C10_missing_file_marker') }, { user: null }),
        update({ caption: 'C10_denied_emergency_marker I cannot breathe', document: document('C10_emergency_file_marker') }, { chat: 731002222, user: 731003333 }),
      ];
      for (const wire of denied) {
        const before = syntheticBytes(fixture.workspace), counts = calls();
        const reply = await dispatch(rebootBot, wire); await drain();
        expect(calls()).toEqual(counts); expect(syntheticBytes(fixture.workspace)).toEqual(before);
        expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
        expect(reply).toHaveLength(1); expect(reply[0].chat).toBe(String(wire.message!.chat.id));
        if (wire === denied[3]) expect(reply[0].text).toBe(EMERGENCY_RESPONSE);
        else expect(reply[0].text).not.toContain('owner turn accepted.');
      }
      fs.writeFileSync(fixture.ownerRecord, '{C10_damaged_binding_marker', { mode: 0o600 });
      const damagedBytes = syntheticBytes(fixture.workspace), damagedCalls = calls();
      const damaged = await dispatch(rebootBot, update({ caption: 'I cannot breathe', document: document('C10_damaged_file_marker') }));
      await drain(); expect(damaged).toEqual([{ chat: String(ownerChat), text: EMERGENCY_RESPONSE }]);
      expect(calls()).toEqual(damagedCalls); expect(syntheticBytes(fixture.workspace)).toEqual(damagedBytes);
      fs.writeFileSync(fixture.ownerRecord, binding, { mode: 0o600 });
      await daemon.shutdown(); daemon = undefined;
      expect(start).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledTimes(2); expect(polling.size).toBe(0);
      for (const lease of [configLease, fixture.workspaceLease]) expect(fs.existsSync(lease)).toBe(false);
      expect(fs.readFileSync(fixture.configPath)).toEqual(configBytes); expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
      expect(send.mock.calls.length).toBe(replies.length);
      const logs = JSON.stringify(output);
      for (const marker of [code, token, root, String(ownerChat), String(ownerUser), '731002222', '731003333', '731004444', 'C10_first_health_marker', 'C10_unpaired_stranger_marker', 'C10_after_onboarding_marker', 'C10_media_caption_marker', 'C10_streamed_attachment_marker', 'C10_display_name_marker', 'C10_transport_path_marker', 'C10_owner_file_marker', 'C10_denied_', 'C10_missing_', 'C10_emergency_', 'C10_damaged_']) expect(logs).not.toContain(marker);
      expect(logs).toContain('stage=pairing outcome=paired');
      expect(logs).toContain(`stage=media-intake outcome=saved bytes=${body.length}`);
      expect(logs).toContain('reason=already-bound'); expect(logs).toContain('reason=non-private-chat');
      expect(logs).toContain('operation=stop outcome=stopped');
    } finally {
      await daemon?.shutdown();
      for (const lifecycle of polling.values()) lifecycle.release();
      [registrations, start, stop, send, ...spies].forEach(spy => spy.mockRestore());
    }
  }, 120_000);

  it.each(['later event', 'spent failed-event replay'])('keeps %s silent once the day\'s allowance is spent, with UTC rollover and emergency controls', async (attempt) => {
    expect((await setup()).code).toBe(0);
    let instant = new Date('2026-10-09T23:50:00.000Z');
    const clock: Clock = { now: () => new Date(instant) };
    const codes = new CryptoPairingCodePort();
    const matches = jest.spyOn(codes, 'matches'); // Call through real verification.
    const admission = admissionFor(undefined, clock, codes);
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('challenge not issued');
    const wrong = issued.plaintext === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA';
    const provider = new ScriptedProvider([textResponse('Noted.')]);
    let builds = 0;
    const controls = { clock, codes, createProvider: (): LLMProvider => { builds += 1; return provider; } };
    const daemon = await bootDaemon(provider, undefined, undefined, controls);
    const sent: string[] = [];
    const deliver = (id: string, text: string): Promise<void> => daemon.gateway.deliverMessage(
      telegramMessage(OWNER_CHAT, OWNER_USER, id, text), async reply => { sent.push(reply); },
    );
    try {
      await deliver('failed-1', wrong);
      const firstBytes = fs.readFileSync(fixture.ownerRecord);
      await deliver('failed-1', wrong); // An under-limit duplicate costs and verifies nothing.
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(firstBytes);
      expect(matches).toHaveBeenCalledTimes(1);
      await deliver('failed-2', wrong);
      await deliver('failed-3', wrong);
      expect(matches).toHaveBeenCalledTimes(3);
      expect(JSON.parse(fs.readFileSync(fixture.ownerRecord, 'utf8')).phase).toBe('unpaired');
      const reissued = issued;
      const lockedBytes = syntheticBytes(root);
      sent.length = 0;
      for (const id of attempt === 'later event' ? ['fourth', 'fifth'] : ['failed-1', 'failed-3']) {
        await deliver(id, reissued.plaintext);
      }
      expect(syntheticBytes(root)).toEqual(lockedBytes);
      expect(matches).toHaveBeenCalledTimes(3);
      expect(builds).toBe(0);
      expect(provider.chatCalls).toHaveLength(0);
      expect(sent).toEqual([]);
      await deliver('limited-emergency', 'I cannot breathe');
      expect(sent).toEqual([EMERGENCY_RESPONSE]);
      expect(syntheticBytes(root)).toEqual(lockedBytes);
      expect(matches).toHaveBeenCalledTimes(3);
      instant = new Date('2026-10-10T00:05:00.000Z');
      sent.length = 0;
      await deliver('failed-1', reissued.plaintext);
      expect(sent).toEqual(['Pairing complete. This chat is now connected to the owner.']);
      expect(matches).toHaveBeenCalledTimes(4);
      const bound = fs.readFileSync(fixture.ownerRecord);
      await deliver('failed-1', reissued.plaintext);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toBe(sent[0]);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(bound);
      expect(provider.chatCalls).toHaveLength(0);
      expect(daemon.gateway.runtimeInstance!.sessions!.getHistory(OWNER_CHAT)).toEqual([]);
    } finally { await daemon.shutdown(); }
  });

  it('captures the first owner narrative once when a stranger arrives first concurrently', async () => {
    expect((await setup()).code).toBe(0);
    const issued = await admissionFor().issueChallenge();
    if (issued.kind !== 'issued') throw new Error('challenge not issued');
    const provider = new ScriptedProvider([textResponse('Noted.')]);
    let builds = 0;
    const daemon = await bootDaemon(provider, undefined, undefined, {
      createProvider: () => { builds += 1; return provider; },
    });
    const replies: string[] = [];
    const narrative = 'headache'; // A bound owner's eight-letter narrative is not a code.
    try {
      await daemon.gateway.deliverMessage(telegramMessage(OWNER_CHAT, OWNER_USER, 'pair', issued.plaintext), async () => {});
      const binding = fs.readFileSync(fixture.ownerRecord);
      const stranger = daemon.gateway.deliverMessage(telegramMessage('stranger-chat', 'stranger-user', 'first', 'hello'), async () => {});
      const owner = daemon.gateway.deliverMessage(telegramMessage(OWNER_CHAT, OWNER_USER, 'narrative', narrative), async text => { replies.push(text); });
      await Promise.all([stranger, owner]);
      const runtime = daemon.gateway.runtimeInstance;
      await runtime?.drainBackgroundOperations();
      await runtime?.writeQueue?.drain();
      const bytes = syntheticBytes(fixture.workspace);
      const transcript = Object.entries(bytes).filter(([p]) => p.endsWith('.jsonl') && p.includes('sessions/'))
        .map(([, hex]) => Buffer.from(hex, 'hex').toString('utf8')).join('\n');
      const capture = Object.entries(bytes).filter(([p]) => p.startsWith('memory/') && p.endsWith('.md'))
        .map(([, hex]) => Buffer.from(hex, 'hex').toString('utf8')).join('\n');
      expect(transcript.split(narrative)).toHaveLength(2);
      expect(capture.split(narrative)).toHaveLength(2);
      expect(runtime).toBeDefined();
      expect(builds).toBe(4); // Main, side-effect medical, embedding and runtime medical factories.
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatch(/personal health companion|before we start/i);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
    } finally { await daemon.shutdown(); }
  });

  it('shares a held real owner construction and reports failed promotion and retry once', async () => {
    expect((await setup()).code).toBe(0);
    const issued = await admissionFor().issueChallenge();
    if (issued.kind !== 'issued') throw new Error('challenge not issued');
    const entered = heldEvent(), gate = heldEvent();
    let embeddings = 0, builds = 0, fail = true;
    const provider: LLMProvider = {
      modelName: 'held-external-io', chat: async () => textResponse('Noted.'),
      embed: async () => { embeddings += 1; if (embeddings === 1) { entered.release(); await gate.promise; } return new Array(768).fill(0); },
    };
    const events: DiagnosticEvent[] = [];
    const daemon = await bootDaemon(provider, { emit: event => { events.push(event); } }, undefined, {
      createProvider: () => { builds += 1; if (fail) { fail = false; throw new Error('synthetic provider construction failure'); } return provider; },
    });
    const replies: string[] = [];
    const send = (id: string, text: string): Promise<void> => daemon.gateway.deliverMessage(telegramMessage(OWNER_CHAT, OWNER_USER, id, text), async reply => { replies.push(reply); });
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    try {
      await send('pair', issued.plaintext);
      await send('failed', 'first failed promotion');
      expect(daemon.gateway.servesPairingOnly).toBe(true);
      expect(builds).toBe(1);
      first = send('retry', 'I slept badly last night');
      await entered.promise; // Held external embedding IO inside real storage/runtime construction.
      second = send('concurrent', 'I walked today');
      expect(daemon.gateway.getShutdownDisposition()).toBe('pending');
      expect(builds).toBe(4);
      await expect(bootDaemon(provider)).rejects.toThrow(/holds this config resource/);
      gate.release();
      await Promise.all([first, second]);
      await daemon.gateway.runtimeInstance!.drainBackgroundOperations();
      await daemon.gateway.runtimeInstance!.writeQueue!.drain();
      expect(builds).toBe(5); // One failed main factory, then one complete serving construction.
      const history = daemon.gateway.runtimeInstance!.sessions!.getHistory(OWNER_CHAT).filter(m => m.role === 'user');
      for (const text of ['I slept badly last night', 'I walked today']) expect(history.filter(m => m.content === text)).toHaveLength(1);
      expect(replies).toHaveLength(4); // Pair, failed-build refusal, and both eligible messages.
      expect(events.filter(event => event.stage === 'start-stop' && 'operation' in event && event.operation === 'promotion')).toEqual([
        expect.objectContaining({ outcome: 'failed', reason: 'build-failed' }),
        expect.objectContaining({ outcome: 'started' }),
      ]);
    } finally { gate.release(); await Promise.all([first, second]); await daemon.shutdown(); }
  });

  it('distinguishes a promotion blocked by real unsettled work and keeps settlement restart usable', async () => {
    expect((await setup()).code).toBe(0);
    const issued = await admissionFor().issueChallenge();
    if (issued.kind !== 'issued') throw new Error('challenge fixture failed');
    const unpaired = fs.readFileSync(fixture.ownerRecord);
    const entered = heldEvent(), gate = heldEvent();
    let hold = false, builds = 0;
    const provider: LLMProvider = {
      modelName: 'held-reindex', chat: async () => textResponse('Noted.'),
      embed: async () => { if (hold) { entered.release(); await gate.promise; } return new Array(768).fill(0); },
    };
    const events: DiagnosticEvent[] = [];
    const daemon = await bootDaemon(provider, { emit: event => { events.push(event); } }, undefined, { createProvider: () => { builds += 1; return provider; } });
    const send = (id: string, text: string): Promise<void> => daemon.gateway.deliverMessage(telegramMessage(OWNER_CHAT, OWNER_USER, id, text), async () => {});
    let held: Promise<void> | undefined;
    try {
      await send('pair', issued.plaintext); await send('first', 'initial narrative');
      const runtime = daemon.gateway.runtimeInstance!;
      await runtime.drainBackgroundOperations(); await runtime.writeQueue!.drain();
      const binding = fs.readFileSync(fixture.ownerRecord);
      hold = true; held = send('held', 'pending narrative'); await entered.promise;
      expect(runtime.getShutdownDisposition()).toBe('pending');
      fs.writeFileSync(fixture.ownerRecord, unpaired, { mode: 0o600 });
      await daemon.gateway.start();
      fs.writeFileSync(fixture.ownerRecord, binding, { mode: 0o600 });
      events.length = 0; const before = builds;
      await send('blocked', '/status');
      expect(daemon.gateway.runtimeInstance).toBe(runtime);
      expect(daemon.gateway.getShutdownDisposition()).toBe('pending');
      expect(builds).toBe(before);
      const refused = events.filter(event => event.stage === 'start-stop');
      hold = false; gate.release(); await held;
      await runtime.drainBackgroundOperations(); await runtime.writeQueue!.drain();
      await runtime.drainAndClose();
      for (let index = 0; index < 100 && daemon.gateway.getShutdownDisposition() === 'pending'; index += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(daemon.gateway.getShutdownDisposition()).toBe('quiescent');
      await daemon.gateway.start();
      expect(daemon.gateway.servesPairingOnly).toBe(false);
      expect(daemon.gateway.runtimeInstance).not.toBe(runtime);
      expect(builds).toBe(before + 4);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
      expect(refused).toEqual([expect.objectContaining({ operation: 'promotion', outcome: 'refused', reason: 'previous-work-unsettled' })]);
      expect(events.filter(event => event.stage === 'start-stop')).toEqual([
        expect.objectContaining({ operation: 'promotion', outcome: 'refused', reason: 'previous-work-unsettled' }),
        expect.objectContaining({ operation: 'start', outcome: 'started' }),
      ]);
    } finally { hold = false; gate.release(); await held; await daemon.shutdown(); }
  }, 120_000);

  it('reports a held promotion interrupted by shutdown as refused rather than started', async () => {
    expect((await setup()).code).toBe(0);
    const issued = await admissionFor().issueChallenge();
    if (issued.kind !== 'issued') throw new Error('challenge fixture failed');
    const entered = heldEvent(), gate = heldEvent();
    const provider: LLMProvider = {
      modelName: 'held-build', chat: async () => textResponse('Noted.'),
      embed: async () => { entered.release(); await gate.promise; return new Array(768).fill(0); },
    };
    const events: DiagnosticEvent[] = [];
    const daemon = await bootDaemon(provider, { emit: event => { events.push(event); } });
    let turn: Promise<void> | undefined;
    try {
      await daemon.gateway.deliverMessage(telegramMessage(OWNER_CHAT, OWNER_USER, 'pair', issued.plaintext), async () => {});
      const binding = fs.readFileSync(fixture.ownerRecord);
      turn = daemon.gateway.deliverMessage(telegramMessage(OWNER_CHAT, OWNER_USER, 'held', 'shutdown narrative'), async () => {});
      await entered.promise;
      const stopping = daemon.shutdown(); gate.release(); await Promise.all([stopping, turn]);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
      expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
      expect(events.filter(event => event.stage === 'start-stop' && event.operation === 'promotion')).toEqual([
        expect.objectContaining({ outcome: 'refused', reason: 'shutdown-in-progress' }),
      ]);
      expect(events.filter(event => event.stage === 'start-stop' && event.operation === 'stop')).toHaveLength(1);
    } finally { gate.release(); await turn; await daemon.shutdown(); }
  }, 120_000);

  it('gives denied raw emergencies guidance with no construction, fetch or writes, preserving the owner emergency flow', async () => {
    expect((await setup()).code).toBe(0);
    const issued = await admissionFor().issueChallenge();
    if (issued.kind !== 'issued') throw new Error('challenge not issued');
    const provider = new ScriptedProvider([textResponse('Noted.')]);
    let builds = 0, opens = 0;
    const source: MediaSourcePort = { open: async () => { opens += 1; throw new Error('denied media must not open'); } };
    const daemon = await bootDaemon(provider, undefined, source, { createProvider: () => { builds += 1; return provider; } });
    const send = async (message: IncomingMessage): Promise<string[]> => {
      const replies: string[] = [];
      await daemon.gateway.deliverMessage(message, async text => { replies.push(text); });
      return replies;
    };
    try {
      await send(telegramMessage(OWNER_CHAT, OWNER_USER, 'pair', issued.plaintext));
      const binding = fs.readFileSync(fixture.ownerRecord);
      const denied = [
        telegramMessage('stranger-chat', 'stranger-user', 's', 'I cannot breathe'),
        { ...telegramMessage(OWNER_CHAT, OWNER_USER, 'g', 'I cannot breathe'), chatType: 'group' as const },
        { ...telegramMessage(OWNER_CHAT, OWNER_USER, 'c', 'I cannot breathe'), chatType: 'channel' as const },
        { ...telegramMessage(OWNER_CHAT, '', 'missing-user', 'I cannot breathe') },
        { ...telegramMessage(OWNER_CHAT, OWNER_USER, 'missing-type', 'I cannot breathe'), chatType: undefined },
        { ...telegramMessage(OWNER_CHAT, OWNER_USER, 'missing-channel', 'I cannot breathe'), channel: undefined },
        { ...telegramMessage(OWNER_CHAT, OWNER_USER, 'missing-event', 'I cannot breathe'), eventId: undefined },
        telegramMessage('stranger-chat', 'stranger-user', 'label', 'User id: I want to kill myself'),
      ];
      for (const message of denied) {
        const before = syntheticBytes(root);
        const response = await send({ ...message, media: { channel: 'telegram', fileId: 'denied', kind: 'document' } });
        expect(syntheticBytes(root)).toEqual(before);
        expect(builds).toBe(0); expect(opens).toBe(0); expect(provider.chatCalls).toHaveLength(0);
        expect(daemon.gateway.runtimeInstance).toBeUndefined();
        expect(response).toEqual([EMERGENCY_RESPONSE]);
      }
      // Transport fields and an untrusted flag cannot turn ordinary denied text into an emergency.
      const metadata = { ...telegramMessage('stranger-chat', 'I cannot breathe', 'metadata', 'hello'), replyToMessageId: 'I cannot breathe', isEmergency: true };
      const beforeMetadata = syntheticBytes(root);
      expect((await send(metadata))[0]).toMatch(/not connected/i);
      expect(syntheticBytes(root)).toEqual(beforeMetadata);
      for (const damage of ['corrupt', 'missing', 'wrong-owner', 'unreadable']) {
        if (damage === 'missing') fs.unlinkSync(fixture.ownerRecord);
        else if (damage === 'unreadable') { fs.unlinkSync(fixture.ownerRecord); fs.mkdirSync(fixture.ownerRecord, { mode: 0o700 }); }
        else fs.writeFileSync(fixture.ownerRecord, damage === 'corrupt' ? '{broken' : binding.toString().replace('"default"', '"different-owner"'), { mode: 0o600 });
        const before = syntheticBytes(root);
        expect(await send(telegramMessage(OWNER_CHAT, OWNER_USER, damage, 'I cannot breathe'))).toEqual([EMERGENCY_RESPONSE]);
        expect(syntheticBytes(root)).toEqual(before);
        expect(builds).toBe(0); expect(opens).toBe(0); expect(provider.chatCalls).toHaveLength(0);
        if (damage === 'unreadable') fs.rmdirSync(fixture.ownerRecord);
        fs.writeFileSync(fixture.ownerRecord, binding, { mode: 0o600 });
      }
      const beforeOwner = syntheticBytes(root);
      expect(await send(telegramMessage(OWNER_CHAT, OWNER_USER, 'owner-emergency', 'I cannot breathe'))).toEqual([EMERGENCY_RESPONSE]);
      await daemon.gateway.runtimeInstance!.drainBackgroundOperations();
      await daemon.gateway.runtimeInstance!.writeQueue!.drain();
      expect(syntheticBytes(root)).not.toEqual(beforeOwner);
      expect(daemon.gateway.runtimeInstance!.sessions!.getHistory(OWNER_CHAT)).toContainEqual({ role: 'user', content: 'I cannot breathe' });
      expect(provider.chatCalls).toHaveLength(0); expect(opens).toBe(0); expect(builds).toBe(4);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
      const ownerRuntime = daemon.gateway.runtimeInstance;
      for (const message of denied) {
        const before = syntheticBytes(root);
        expect(await send({ ...message, media: { channel: 'telegram', fileId: 'denied-after-owner', kind: 'document' } })).toEqual([EMERGENCY_RESPONSE]);
        await ownerRuntime!.drainBackgroundOperations();
        await ownerRuntime!.writeQueue!.drain();
        expect(syntheticBytes(root)).toEqual(before);
        expect(daemon.gateway.runtimeInstance).toBe(ownerRuntime);
        expect(provider.chatCalls).toHaveLength(0); expect(opens).toBe(0); expect(builds).toBe(4);
      }
    } finally { await daemon.shutdown(); }
  });

  it('serves the owner after pairing WITHOUT a restart, in one daemon lifetime', async () => {
    expect((await setup()).code).toBe(0);

    const admission = admissionFor();
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error(`issue failed: ${issued.kind}`);

    const provider = new ScriptedProvider([textResponse('Noted. Rest and hydration help most headaches.')]);
    const sent: string[] = [];
    const handle = await bootDaemon(provider);

    try {
      expect(handle.gateway.servesPairingOnly).toBe(true);
      expect(handle.gateway.runtimeInstance).toBeUndefined();

      const deliver = (identity: TransportIdentity, text: string) =>
        handle.gateway.deliverMessage(
          { chatId: identity.chatId, userId: identity.userId, text, channel: 'telegram', chatType: 'private', eventId: identity.eventId },
          async (reply) => { sent.push(reply); },
        );

      const ownerIdentity = identityFor('owner-chat', 'owner-user', '1');

      await deliver(ownerIdentity, issued.plaintext);
      expect(sent.join('\n')).toMatch(/pairing complete/i);

      sent.length = 0;
      await deliver(identityFor('owner-chat', 'owner-user', '2'), 'Can I eat daal chawal?');

      expect(handle.gateway.servesPairingOnly).toBe(false);
      expect(handle.gateway.runtimeInstance).toBeDefined();

      expect(sent.join(' ')).toMatch(/personal health companion|before we start/i);
      expect(sent.join('\n')).not.toMatch(/temporarily unavailable/i);

      const history = handle.gateway.runtimeInstance!.sessions!.getHistory('owner-chat');
      expect(history.map((m) => m.content).join('\n')).toContain('Can I eat daal chawal?');

      sent.length = 0;
      await deliver(identityFor('owner-chat', 'owner-user', '3'), 'skip');
      sent.length = 0;
      await deliver(identityFor('owner-chat', 'owner-user', '4'), 'Can I eat daal chawal?');
      expect(provider.chatCalls.length).toBeGreaterThan(0);
      expect(sent.join('\n')).not.toMatch(/temporarily unavailable/i);
    } finally {
      await handle.shutdown();
    }
  }, 180_000);

  it('runs the whole owner spine with real modules and preserves it across a restart', async () => {
    const setupResult = await setup();
    expect(setupResult.code).toBe(0);
    expect(fs.existsSync(fixture.configPath)).toBe(true);
    expect(fs.existsSync(fixture.ownerRecord)).toBe(true);
    expect(admissionFor().inspectInstallation()).toEqual({ kind: 'unpaired' });

    const issued = await cli(['--config', fixture.configPath, 'pairing', 'issue']);
    expect(issued.code).toBe(0);
    const pairingCode = issued.output.match(/\n\s{4}([A-Z2-9]{8})\s/)![1];

    const provider = new ScriptedProvider([textResponse('Noted. I will keep that in mind.')]);

    const unpaired = await bootDaemon(provider);
    expect(unpaired.kind).toBe('owned');
    try {
      expect(unpaired.gateway.servesPairingOnly).toBe(true);

      const strangerReply = await unpaired.gateway.handleTestMessage('stranger-chat', 'What is my blood pressure?');
      expect(strangerReply).not.toMatch(/blood pressure|Noted/i);
      expect(provider.chatCalls).toHaveLength(0);
      expect(admissionFor().inspectInstallation()).toEqual({ kind: 'unpaired' });
    } finally {
      await unpaired.shutdown();
    }

    const pairing = await admissionFor().handlePairing(
      identityFor(OWNER_CHAT, OWNER_USER, 'bind-1'),
      pairingCode,
    );
    expect(pairing).toMatchObject({ kind: 'paired', boundOwnerId: fixture.ownerId });

    const bindingBytes = fs.readFileSync(fixture.ownerRecord);
    expect(JSON.parse(bindingBytes.toString())).toMatchObject({
      phase: 'bound',
      binding: { channel: 'telegram', chatId: OWNER_CHAT, senderId: OWNER_USER },
    });

    const bound = await bootDaemon(provider);
    expect(bound.kind).toBe('owned');
    try {
      expect(bound.gateway.servesPairingOnly).toBe(false);
      expect(bound.gateway.runtimeInstance).toBeDefined();
      expect(bound.gateway.runtimeInstance!.workspace).toBe(fixture.workspace);

      const callsBeforeStranger = provider.chatCalls.length;
      const strangerReplies: string[] = [];
      await bound.gateway.deliverMessage(telegramMessage('stranger-chat', 'stranger-user', 's1', 'What is my blood pressure?'), async (text) => {
        strangerReplies.push(text);
      });
      expect(strangerReplies.join(' ')).not.toMatch(/Noted/i);
      expect(provider.chatCalls).toHaveLength(callsBeforeStranger);

      const localReply = await bound.gateway.handleTestMessage(OWNER_CHAT, 'I slept badly and my knee hurts.');
      expect(localReply).toMatch(/not connected to this assistant/i);
      expect(provider.chatCalls).toHaveLength(callsBeforeStranger);

      const OWNER_FIRST_MESSAGE = 'I slept badly and my knee hurts.';
      const ownerReplies: string[] = [];
      await bound.gateway.deliverMessage(
        telegramMessage(OWNER_CHAT, OWNER_USER, 'o1', OWNER_FIRST_MESSAGE),
        async (text) => { ownerReplies.push(text); },
      );

      expect(ownerReplies.join(' ')).toMatch(/personal health companion|before we start/i);
      expect(provider.chatCalls).toHaveLength(callsBeforeStranger);

      const history = bound.gateway.runtimeInstance!.sessions!.getHistory(OWNER_CHAT);
      expect(history.map((message) => message.content).join('\n')).toContain(OWNER_FIRST_MESSAGE);

      const skipReplies: string[] = [];
      await bound.gateway.deliverMessage(
        telegramMessage(OWNER_CHAT, OWNER_USER, 'o-skip', 'skip'),
        async (text) => { skipReplies.push(text); },
      );
      expect(skipReplies.join(' ')).toMatch(/skipped|onboarding/i);

      const laterReplies: string[] = [];
      await bound.gateway.deliverMessage(
        telegramMessage(OWNER_CHAT, OWNER_USER, 'o2', 'and my sleep has been worse this week too'),
        async (text) => { laterReplies.push(text); },
      );
      expect(provider.chatCalls.length).toBeGreaterThan(callsBeforeStranger);
      expect(laterReplies.join(' ')).toContain('Noted');
      expect(bound.gateway.runtimeInstance!.workspace).toBe(fixture.workspace);
    } finally {
      await bound.shutdown();
    }

    const rebooted = await bootDaemon(provider);
    try {
      expect(rebooted.gateway.servesPairingOnly).toBe(false);
      expect(rebooted.gateway.runtimeInstance!.workspace).toBe(fixture.workspace);
      expect(admissionFor().inspectInstallation()).toEqual({ kind: 'bound', ownerId: fixture.ownerId });
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(bindingBytes);
    } finally {
      await rebooted.shutdown();
    }

    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
  }, 120_000);

  it('reports useful outcomes through an explicitly supplied diagnostic sink during a real boot', async () => {
    expect((await setup()).code).toBe(0);

    const events: DiagnosticEvent[] = [];
    const capture: DiagnosticSink = { emit: (event) => events.push(event) };
    const owner = identityFor('owner-chat', 'owner-user', '1');
    const replies: string[] = [];
    const deliver = (message: IncomingMessage): Promise<void> =>
      daemon.gateway.deliverMessage(message, async (reply) => { replies.push(reply); });

    const issued = await cli(['--config', fixture.configPath, 'pairing', 'issue']);
    expect(issued.code).toBe(0);
    const pairingCode = issued.output.match(/\b[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}\b/)?.[0];
    expect(pairingCode).toBeTruthy();

    const provider = new ScriptedProvider([textResponse('ok'), textResponse('ok')]);
    const daemon = await bootDaemon(provider, capture);
    try {
      expect(events).toContainEqual(
        expect.objectContaining({ stage: 'owner-admission', outcome: 'pairing-only' }),
      );
      expect(events).toContainEqual(expect.objectContaining({ stage: 'start-stop', outcome: 'started' }));

      await deliver({
        channel: 'telegram', chatType: 'group', eventId: 'telegram:group-999:g1',
        chatId: 'group-999', userId: 'nobody', text: 'what is my blood pressure?',
      });
      expect(events).toContainEqual(
        expect.objectContaining({ stage: 'owner-admission', outcome: 'refused', reason: 'non-private-chat' }),
      );
      expect(replies.join(' ')).not.toMatch(/blood pressure/i);

      await deliver(telegramMessage(owner.chatId, owner.userId, 'p1', pairingCode as string));
      expect(events).toContainEqual(expect.objectContaining({ stage: 'pairing', outcome: 'paired' }));

      await deliver(telegramMessage(owner.chatId, owner.userId, 'm1', 'I slept badly last night'));
      expect(events).toContainEqual(expect.objectContaining({ stage: 'owner-admission', outcome: 'admitted' }));
    } finally {
      await daemon.shutdown();
    }

    expect(events).toContainEqual(expect.objectContaining({ stage: 'start-stop', outcome: 'stopped' }));

    const serialized = JSON.stringify(events);
    for (const secret of [owner.chatId, owner.userId, fixture.ownerRecord, fixture.baseDir, pairingCode as string]) {
      expect(serialized).not.toContain(secret);
    }
    expect(events.length).toBeGreaterThan(4);
    for (const event of events) {
      expect(Number.isFinite(event.durationMs)).toBe(true);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);

  it.each([false, true])('default daemon preserves the owner flow and private output with writer failure=%s', async (writerFails) => {
    expect((await setup()).code).toBe(0);
    const issued = await cli(['--config', fixture.configPath, 'pairing', 'issue']);
    expect(issued.code).toBe(0);
    const code = issued.output.match(/\b[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}\b/)?.[0];
    if (!code) throw new Error('challenge fixture failed');
    const stored = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
    stored.providers.main.baseUrl = 'https://bind_user:bind_password@example.invalid/bind_path?token=bind_query';
    expect(writeConfigDocument(fixture.configPath, stored).status).toBe('committed');
    const captured: unknown[][] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map(method => jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      captured.push(args);
      if (writerFails && method === 'info') throw new Error('writer_error_secret');
    }));
    const provider = new ScriptedProvider([textResponse('Noted.')]);
    let opens = 0;
    const body = 'media_body_secret';
    const source: MediaSourcePort = { open: async ref => {
      opens += 1;
      if (ref.fileId === 'bad_file_id') throw new Error('source_error_secret');
      return { chunks: (async function* (): AsyncGenerator<Uint8Array, void, unknown> { yield Buffer.from(body); })(), cancel: async () => {} };
    } };
    const boot = (): Promise<DaemonHandle> => startDaemon({ configPath: fixture.configPath, homeDir: root, externalIO: { createProvider: () => provider, mediaSource: source } });
    const chat = 'owner_identity', user = 'owner_user';
    const narrative = 'health_secret I slept badly last night';
    let daemon: DaemonHandle | undefined;
    const send = async (message: IncomingMessage): Promise<string[]> => {
      const replies: string[] = [];
      await daemon!.gateway.deliverMessage(message, async text => { replies.push(text); });
      return replies;
    };
    try {
      daemon = await boot(); // No custom Gateway, admission or sink.
      expect(daemon.gateway.servesPairingOnly).toBe(true);
      expect(await send(telegramMessage(chat, user, 'pair_event', code))).toEqual(['Pairing complete. This chat is now connected to the owner.']);
      const binding = fs.readFileSync(fixture.ownerRecord);
      const first = await send(telegramMessage(chat, user, 'narrative_event', narrative));
      expect(first).toHaveLength(1);
      expect((await send(telegramMessage(chat, user, 'skip_event', 'skip'))).join(' ')).toMatch(/skipped|onboarding/i);
      expect((await send(telegramMessage(chat, user, 'turn_event', 'second_health_secret'))).join(' ')).toContain('Noted.');
      const runtime = daemon.gateway.runtimeInstance!;
      await runtime.drainBackgroundOperations(); await runtime.writeQueue!.drain();
      expect(runtime.sessions!.getHistory(chat).filter(message => message.role === 'user' && message.content === narrative)).toHaveLength(1);
      const memory = Object.entries(syntheticBytes(fixture.workspace)).filter(([file]) => file.startsWith('memory/') && file.endsWith('.md')).map(([, hex]) => Buffer.from(hex, 'hex').toString()).join('\n');
      expect(memory).toContain(narrative);
      for (const [id, suffix] of [['good_file_id', 'good'], ['bad_file_id', 'bad']]) {
        const replies = await send({ ...telegramMessage(chat, user, `media_${suffix}`, suffix === 'good' ? '/status' : 'failed_media_health_secret'), media: { channel: 'telegram', fileId: id, kind: 'document', displayName: 'media_name_secret.pdf' } });
        expect(replies).toHaveLength(1);
        if (suffix === 'bad') expect(replies[0]).toMatch(/Failed to retrieve/);
      }
      expect(opens).toBe(2);
      const reports = path.join(fixture.workspace, 'reports');
      expect(fs.readdirSync(reports).filter(file => fs.readFileSync(path.join(reports, file), 'utf8') === body)).toHaveLength(1);
      await runtime.drainBackgroundOperations(); await runtime.writeQueue!.drain();
      for (const message of [
        telegramMessage('stranger_identity', 'stranger_user', 'stranger_event', 'stranger_text I cannot breathe'),
        { ...telegramMessage('group_identity', 'group_user', 'group_event', 'group_text I cannot breathe'), chatType: 'group' as const },
      ]) {
        const before = syntheticBytes(fixture.workspace), calls = provider.chatCalls.length;
        const untrusted = { ...message, mediaPath: path.join(root, 'media_path_secret'), media: { channel: 'telegram', fileId: 'denied_file_id', kind: 'document' as const } };
        expect(await send(untrusted)).toEqual([EMERGENCY_RESPONSE]);
        expect(syntheticBytes(fixture.workspace)).toEqual(before);
        expect(provider.chatCalls).toHaveLength(calls); expect(opens).toBe(2);
      }
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
      await daemon.shutdown(); daemon = undefined;
      expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
      daemon = await boot();
      expect(daemon.gateway.servesPairingOnly).toBe(false);
      expect(daemon.gateway.runtimeInstance!.sessions!.getHistory(chat)).toContainEqual({ role: 'user', content: narrative });
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
      await daemon.shutdown(); daemon = undefined;
      const output = JSON.stringify(captured);
      for (const marker of [chat, user, code, root, narrative, 'second_health_secret', 'failed_media_health_secret', body, 'media_name_secret', 'media_path_secret', 'source_error_secret', 'writer_error_secret', 'stranger', 'group', 'pair_event', 'denied_file_id', 'bind_', 'example.invalid']) expect(output).not.toContain(marker);
      expect(output).toContain('main provider is not localhost');
      const lines = captured.flat().filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('[diagnostic]'));
      for (const prefix of [
        'stage=owner-admission outcome=pairing-only', 'stage=pairing outcome=paired',
        'stage=start-stop operation=promotion outcome=started', 'stage=owner-admission outcome=admitted',
        `stage=media-intake outcome=saved bytes=${Buffer.byteLength(body)}`,
        'stage=media-intake outcome=refused reason=source-failed',
        'stage=owner-admission outcome=refused reason=already-bound',
        'stage=owner-admission outcome=refused reason=non-private-chat',
      ]) expect(lines).toContainEqual(expect.stringContaining(`[diagnostic] ${prefix} `));
      expect(lines.filter(line => line.includes('operation=start outcome=started'))).toHaveLength(2);
      expect(lines.filter(line => line.includes('operation=promotion outcome=started'))).toHaveLength(1);
      expect(lines.filter(line => line.includes('operation=stop outcome=stopped'))).toHaveLength(2);
      for (const line of lines) {
        expect(line).toMatch(/^\[diagnostic\] stage=[a-z-]+ (?:operation=(?:start|promotion|stop) )?outcome=[a-z-]+(?: reason=[a-z-]+)?(?: (?:attempts|bytes)=\d+)? durationMs=\d+(?:\.\d+)?$/);
        expect(Number(line.split('durationMs=')[1])).toBeGreaterThanOrEqual(0);
      }
    } finally { await daemon?.shutdown(); spies.forEach(spy => spy.mockRestore()); }
  }, 120_000);

  it.each(['leaf', 'ancestor'])('refuses a static %s staging alias before source or filesystem effects', async (alias) => {
    expect((await setup()).code).toBe(0);
    const issued = await admissionFor().issueChallenge();
    if (issued.kind !== 'issued') throw new Error('challenge fixture failed');
    await admissionFor().handlePairing(identityFor(OWNER_CHAT, OWNER_USER, 'alias-pair'), issued.plaintext);
    const binding = fs.readFileSync(fixture.ownerRecord);
    const events: DiagnosticEvent[] = [];
    let opens = 0;
    const mediaSource: MediaSourcePort = {
      open: async () => {
        opens += 1;
        return { chunks: (async function* (): AsyncGenerator<Uint8Array, void, unknown> { yield Buffer.from('synthetic upload'); })(), cancel: async (): Promise<void> => {} };
      },
    };
    const daemon = await bootDaemon(new ScriptedProvider([textResponse('Noted.')]), { emit: event => { events.push(event); } }, mediaSource);
    const state = path.join(fixture.workspace, '.state');
    const staging = path.join(state, 'media-staging');
    const outside = path.join(root, 'synthetic-outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    const relocatedState = path.join(outside, 'state');
    if (alias === 'ancestor') {
      fs.renameSync(state, relocatedState);
      fs.symlinkSync(relocatedState, state, 'dir');
    }
    const target = alias === 'ancestor' ? path.join(relocatedState, 'media-staging') : path.join(outside, 'media-staging');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.chmodSync(target, 0o750); // Synthetic permission sentinel, intentionally wider.
    const sentinel = path.join(target, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside sentinel', { mode: 0o600 });
    if (alias === 'leaf') fs.symlinkSync(target, staging, 'dir');
    const snapshot = (): { names: string[]; mode: number; sentinel: string } => ({ names: fs.readdirSync(target).sort(), mode: fs.statSync(target).mode & 0o777, sentinel: fs.readFileSync(sentinel, 'utf8') });
    const before = snapshot();
    const message = { ...telegramMessage(OWNER_CHAT, OWNER_USER, 'alias-media', '/status'), media: { channel: 'telegram', fileId: 'synthetic-alias', kind: 'document' as const, displayName: 'report.pdf' } };
    try {
      await daemon.gateway.deliverMessage(message, async () => {});
      const after = snapshot();
      const refusedOpens = opens;
      const intake = events.filter(event => event.stage === 'media-intake');
      console.info(JSON.stringify({ case: `staging-alias-${alias}`, sourceOpens: refusedOpens, outsideAdded: after.names.length - before.names.length, beforeMode: before.mode, afterMode: after.mode, sentinelUnchanged: after.sentinel === before.sentinel }));
      if (alias === 'leaf') fs.unlinkSync(staging);
      else {
        fs.unlinkSync(state);
        fs.renameSync(relocatedState, state);
        fs.renameSync(staging, path.join(outside, 'preserved-lane'));
      }
      await daemon.gateway.deliverMessage({ ...message, eventId: 'telegram:owner-chat:allowed-media' }, async () => {});
      const reports = path.join(fixture.workspace, 'reports');
      const saved = fs.readdirSync(reports).filter(name => fs.readFileSync(path.join(reports, name), 'utf8') === 'synthetic upload');
      expect(saved).toHaveLength(1);
      expect(fs.statSync(path.join(reports, saved[0])).mode & 0o777).toBe(0o600);
      expect(fs.statSync(staging).mode & 0o777).toBe(0o700);
      expect(opens).toBe(refusedOpens + 1);
      expect(events).toContainEqual(expect.objectContaining({ stage: 'media-intake', outcome: 'saved' }));
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
      expect(after).toEqual(before);
      expect(refusedOpens).toBe(0);
      expect(intake).toEqual([expect.objectContaining({ outcome: 'refused', reason: 'source-failed' })]);
      const textReplies: string[] = [];
      await daemon.gateway.deliverMessage(telegramMessage(OWNER_CHAT, OWNER_USER, 'after-alias-text', 'hello'), async text => { textReplies.push(text); });
      expect(textReplies.join(' ')).not.toMatch(/temporarily unavailable/i);
    } finally {
      if (fs.lstatSync(state).isSymbolicLink()) { fs.unlinkSync(state); fs.renameSync(relocatedState, state); }
      await daemon.shutdown();
    }
  }, 120_000);

  it('a restart sweeps the owner\'s crash-left staging and touches nothing else', async () => {
    expect((await setup()).code).toBe(0);
    const issued = await cli(['--config', fixture.configPath, 'pairing', 'issue']);
    expect(issued.code).toBe(0);
    const pairingCode = issued.output.match(/\n\s{4}([A-Z2-9]{8})\s/)![1];
    expect(await admissionFor().handlePairing(identityFor(OWNER_CHAT, OWNER_USER, 'bind-1'), pairingCode))
      .toMatchObject({ kind: 'paired' });

    const first = await bootDaemon(new ScriptedProvider([textResponse('first boot')]), undefined, {
      open: async () => ({ chunks: (async function* (): AsyncGenerator<Uint8Array, void, unknown> { yield Buffer.from('adopted before restart'); })(), cancel: async (): Promise<void> => {} }),
    });
    let previouslyAdopted = '';
    try {
      expect(first.kind).toBe('owned');
      expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
      await first.gateway.deliverMessage({ ...telegramMessage(OWNER_CHAT, OWNER_USER, 'before-restart-media', '/status'),
        media: { channel: 'telegram', fileId: 'synthetic-before-restart', kind: 'document', displayName: 'earlier.pdf' } }, async () => {});
      const reports = path.join(fixture.workspace, 'reports');
      const adopted = fs.readdirSync(reports).filter(name => fs.readFileSync(path.join(reports, name), 'utf8') === 'adopted before restart');
      expect(adopted).toHaveLength(1);
      previouslyAdopted = path.join(reports, adopted[0]);
      expect(fs.statSync(previouslyAdopted).mode & 0o777).toBe(0o600);
    } finally { await first.shutdown(); }
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);

    const ownerStaging = resolveOwnerPaths(fixture.baseDir, asProfileId(fixture.ownerId)!).mediaStaging;
    const secondaryStaging = resolveOwnerPaths(fixture.baseDir, 'secondary-owner' as never).mediaStaging;

    const orphanSource: MediaSourcePort = {
      open: async () => ({ chunks: (async function* (): AsyncGenerator<Uint8Array, void, unknown> { yield Buffer.from('staged bytes never adopted'); })(), cancel: async (): Promise<void> => {} }),
    };
    const orphanStager = new FsMediaStager(orphanSource, ownerStaging, { trustedBaseDir: fixture.workspace });
    const stageOrphan = (): Promise<MediaStageResult> => orphanStager.stage({ channel: 'telegram', fileId: 'synthetic-orphan', kind: 'document', displayName: 'orphan.pdf' }, new AbortController().signal);
    const firstOrphan = await stageOrphan();
    const secondOrphan = await stageOrphan();
    if (firstOrphan.kind !== 'saved' || secondOrphan.kind !== 'saved') throw new Error('orphan fixture did not stage');
    const orphanUnadopted = firstOrphan.absolutePath;
    const orphanPartial = `${secondOrphan.absolutePath}.part`;
    fs.renameSync(secondOrphan.absolutePath, orphanPartial);
    fs.writeFileSync(orphanPartial, 'partial bytes', { mode: 0o600 });
    const adoptedReport = path.join(fixture.workspace, 'reports', '2026-10-02-sleep.md');

    fs.mkdirSync(ownerStaging, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(adoptedReport), { recursive: true, mode: 0o700 });
    fs.mkdirSync(secondaryStaging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(adoptedReport, '# Sleep log\n\nSlept badly.\n', { mode: 0o600 });

    const outsideSibling = path.join(path.dirname(ownerStaging), 'unrelated-note.txt');
    const secondaryOrphan = path.join(secondaryStaging, 'secondary-inflight.pdf');
    const outsideWorkspace = path.join(fixture.baseDir, 'outside-workspace.txt');
    fs.writeFileSync(outsideSibling, 'not media', { mode: 0o600 });
    fs.writeFileSync(secondaryOrphan, 'a real second owner\'s staged media', { mode: 0o600 });
    fs.writeFileSync(outsideWorkspace, 'unrelated state', { mode: 0o600 });
    const unrelated = path.join(ownerStaging, 'unrelated.txt');
    const lookalike = path.join(ownerStaging, 'medclaw-media-not-a-uuid-upload.pdf.part');
    const linkArtifact = await stageOrphan();
    const directoryArtifact = await stageOrphan();
    if (linkArtifact.kind !== 'saved' || directoryArtifact.kind !== 'saved') throw new Error('preserved fixture did not stage');
    const link = linkArtifact.absolutePath;
    const directory = directoryArtifact.absolutePath;
    fs.unlinkSync(link);
    fs.unlinkSync(directory);
    fs.writeFileSync(unrelated, 'in-lane sentinel', { mode: 0o600 });
    fs.writeFileSync(lookalike, 'lookalike partial', { mode: 0o600 });
    fs.symlinkSync(outsideWorkspace, link);
    fs.mkdirSync(directory, { mode: 0o700 });
    const bindingBefore = fs.readFileSync(fixture.ownerRecord);

    const provider = new ScriptedProvider([textResponse('Noted.'), textResponse('Got it.')]);
    const mediaSource: MediaSourcePort = {
      open: async () => ({
        chunks: (async function* () {
          yield new TextEncoder().encode('%PDF-1.4 post-sweep owner media');
        })(),
        cancel: async () => {},
      }),
    };
    const daemon = await bootDaemon(provider, undefined, mediaSource);
    try {
      expect(daemon.kind).toBe('owned');
      expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
      expect(daemon.gateway.stagingCleanupResult).toEqual({ kind: 'complete', inspected: 6, removed: 2 });

      expect(fs.existsSync(orphanUnadopted)).toBe(false);
      expect(fs.existsSync(orphanPartial)).toBe(false);
      expect(fs.existsSync(unrelated)).toBe(true);
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('in-lane sentinel');
      expect(fs.readFileSync(lookalike, 'utf8')).toBe('lookalike partial');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(outsideWorkspace);
      expect(fs.lstatSync(directory).isDirectory()).toBe(true);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(bindingBefore);

      expect(fs.readFileSync(adoptedReport, 'utf8')).toBe('# Sleep log\n\nSlept badly.\n');
      expect(fs.readFileSync(previouslyAdopted, 'utf8')).toBe('adopted before restart');
      expect(fs.statSync(previouslyAdopted).mode & 0o777).toBe(0o600);

      expect(fs.readFileSync(outsideSibling, 'utf8')).toBe('not media');
      expect(fs.readFileSync(secondaryOrphan, 'utf8')).toBe('a real second owner\'s staged media');
      expect(fs.readFileSync(outsideWorkspace, 'utf8')).toBe('unrelated state');

      expect(admissionFor().inspectInstallation()).toMatchObject({ kind: 'bound' });

      const replies: string[] = [];
      await daemon.gateway.deliverMessage(
        telegramMessage(OWNER_CHAT, OWNER_USER, 'post-sweep-1', 'I slept badly last night'),
        async (reply) => { replies.push(reply); },
      );
      expect(provider.chatCalls.length).toBeGreaterThan(0);
      expect(replies.join('\n')).not.toMatch(/temporarily unavailable/i);

      const mediaReplies: string[] = [];
      await daemon.gateway.deliverMessage(
        {
          ...telegramMessage(OWNER_CHAT, OWNER_USER, 'post-sweep-media', 'here is my lab result'),
          media: { channel: 'telegram', fileId: 'file-post-sweep', kind: 'document', displayName: 'lab.pdf' },
        },
        async (reply) => { mediaReplies.push(reply); },
      );
      expect(mediaReplies.join('\n')).not.toMatch(/temporarily unavailable/i);
      const reportsDir = path.join(fixture.workspace, 'reports');
      const adopted = fs.readdirSync(reportsDir).filter((name) => {
        const full = path.join(reportsDir, name);
        return fs.statSync(full).isFile() && fs.readFileSync(full, 'utf8').includes('post-sweep owner media');
      });
      expect(adopted.length).toBeGreaterThan(0);
      for (const name of adopted) expect(fs.statSync(path.join(reportsDir, name)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(ownerStaging).mode & 0o777).toBe(0o700);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(bindingBefore);
      expect(fs.existsSync(secondaryOrphan)).toBe(true);
    } finally {
      await daemon.shutdown();
    }
  }, 180_000);

  it('refuses to start a second daemon while the first holds the installation', async () => {
    expect((await setup()).code).toBe(0);

    const provider = new ScriptedProvider([textResponse('ok')]);
    const first = await bootDaemon(provider);
    try {
      await expect(bootDaemon(provider)).rejects.toThrow(/holds this config resource/);
    } finally {
      await first.shutdown();
    }

    const second = await bootDaemon(provider);
    expect(second.kind).toBe('owned');
    await second.shutdown();
  }, 120_000);

  it('releases ownership only once an in-flight turn has settled', async () => {
    expect((await setup()).code).toBe(0);
    const issued = await cli(['--config', fixture.configPath, 'pairing', 'issue']);
    const pairingCode = issued.output.match(/\n\s{4}([A-Z2-9]{8})\s/)![1];
    expect(
      await admissionFor().handlePairing(identityFor(OWNER_CHAT, OWNER_USER, 'bind-1'), pairingCode),
    ).toMatchObject({ kind: 'paired' });

    const provider = new ScriptedProvider([textResponse('Noted.')]);

    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let entered = false;
    const TURN_MARKER = 'a real turn that will still be running';
    const gatedProvider: LLMProvider = {
      modelName: 'gated',
      chat: async (messages) => {
        const prompt = messages.map((message) => message.content).join('\n');
        if (!prompt.includes(TURN_MARKER)) return textResponse('Noted.');
        entered = true;
        await gate;
        return textResponse('Noted.');
      },
      embed: async () => new Array(768).fill(0),
    };

    const config = await loadRuntimeConfig({ configPath: fixture.configPath });
    const daemon = await startDaemon({
      services: new InstallationService(new DirectoryLease()),
      configPath: fixture.configPath,
      homeDir: root,
      createGateway: () => {
        const gateway = new Gateway(config, {
          admission: admissionFor(),
          ownerId: asProfileId(fixture.ownerId)!,
          createProvider: (cfg) => (cfg === config.providers.main ? gatedProvider : provider),
        });
        return gateway;
      },
    });

    await daemon.gateway.deliverMessage(
      telegramMessage(OWNER_CHAT, OWNER_USER, 'skip-during-drain', 'skip'),
      async () => undefined,
    );
    const turn = daemon.gateway.deliverMessage(
      telegramMessage(OWNER_CHAT, OWNER_USER, 'during-drain', 'a real turn that will still be running'),
      async () => undefined,
    );
    for (let i = 0; i < 400 && !entered; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(entered).toBe(true);

    expect(daemon.gateway.getShutdownDisposition()).toBe('pending');
    expect(daemon.gateway.shutdownWorkInFlight().turns).toBeGreaterThan(0);

    await daemon.shutdown();
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
    expect(daemon.gateway.shutdownWorkInFlight().turns).toBeGreaterThan(0);

    openGate();
    await turn;
    await daemon.shutdown();

    expect(daemon.gateway.shutdownWorkInFlight().turns).toBe(0);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
  }, 120_000);
});
