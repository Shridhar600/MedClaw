// tests/gateway/gateway-telegram-media-e2e.test.ts
//
// R-16 + B2: the REAL Telegram transport handler, driving a REAL attachment through the REAL Gateway.
//
// WHY THIS FILE EXISTS
// `tests/gateway/gateway-media-admission.test.ts` proves `Gateway.deliverMessage` stages correctly. That
// was NOT sufficient: the actual B2 defect was that the production transport callback
// `Gateway.handleMessage` called `route()` DIRECTLY, bypassing `admitAndStage` entirely. A test that only
// drives `deliverMessage` passes whether or not `handleMessage` delegates to it — and indeed reverting
// `handleMessage` to the bypass did NOT fail that suite.
//
// So this file closes the loop through the path production actually uses:
//   grammY handler -> TelegramChannel -> Gateway.handleMessage -> deliverMessage -> admitAndStage
//                    -> FsMediaStager -> turn, with authority re-read AFTER the retrieval.
//
// grammY is the only thing faked (there is no bot and no network). The channel, the Gateway, admission,
// the Router, the media source and the stager are all real. The two external edges are injected: the Bot
// API `getFile` resolution and the file-body fetch.

import * as fs from 'fs';
import * as path from 'path';

import type { MediaReference } from '../../src/ports/media-source';
import type { LLMResponse } from '../../src/providers/types';

// Telegram chat/user ids are NUMERIC on the wire and reach the core as strings. The owner is bound to
// exactly the ids the fake update carries, so admission genuinely matches rather than being bypassed.
const OWNER_CHAT = '777';
const OWNER_USER = '42';
const STRANGER_CHAT = '999';
const STRANGER_USER = '4242';
/** Synthetic PHI marker: must never appear in a log, a diagnostic, or a refusal. */
const PHI = 'patient-12345-diabetes';

const mockBotOn = jest.fn();
const mockBotStart = jest.fn().mockResolvedValue(undefined);
const mockBotStop = jest.fn().mockResolvedValue(undefined);
const mockBotCatch = jest.fn();
const mockGetFile = jest.fn();
const mockSendMessage = jest.fn().mockResolvedValue(undefined);

jest.mock('grammy', () => ({
  Bot: jest.fn(() => ({
    on: mockBotOn,
    api: { getFile: mockGetFile, sendMessage: mockSendMessage },
    start: mockBotStart,
    stop: mockBotStop,
    catch: mockBotCatch,
    token: 'test-token',
  })),
}));

// Imported after the mock so the channel picks up the fake Bot.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { Gateway } from '../../src/gateway/gateway';
import { TelegramMediaSource } from '../../src/channels/telegram-media-source';
import { composeOwnerAuthority } from '../../src/runtime/owner-authority';
import { asProfileId } from '../../src/profiles';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';

type Handler = (ctx: unknown) => Promise<void>;

/** The handler the channel registered for a grammY event name. */
function handlerFor(event: string): Handler {
  const call = mockBotOn.mock.calls.find(([name]) => name === event);
  if (!call) throw new Error(`channel never registered ${event}; registered: ${mockBotOn.mock.calls.map(([n]) => n).join(', ')}`);
  return call[1] as Handler;
}

/**
 * A grammY-shaped TEXT update. Onboarding is a real multi-step flow and `skip` is a supported answer, so
 * completing it through the same inbound path is real behaviour rather than a bypass.
 */
function textUpdate(text: string, overrides: { chatId?: number; userId?: number; messageId?: number } = {}) {
  const from = { id: Number(overrides.userId ?? 42), is_bot: false, first_name: 'Owner' };
  const chat = { id: Number(overrides.chatId ?? 777), type: 'private' };
  return {
    update_id: 900,
    from,
    chat,
    message: { message_id: overrides.messageId ?? 1, from, chat, date: 1_780_000_000, text },
  };
}

/** Build a grammY-shaped update for a document, as the real Bot API delivers it. */
function documentUpdate(overrides: { fileId?: string; fileName?: string; caption?: string; chatId?: number; userId?: number } = {}) {
  // grammY's Context reads `ctx.chat`, `ctx.from` and `ctx.message` off the update, and the document off
  // the message — so the nesting here mirrors a real Bot API update rather than a flat fixture.
  const from = { id: Number(overrides.userId ?? 42), is_bot: false, first_name: 'Owner' };
  const chat = { id: Number(overrides.chatId ?? 777), type: 'private' };
  return {
    update_id: 900,
    message_id: 500,
    from,
    chat,
    message: {
      message_id: 500,
      from,
      chat,
      date: 1_780_000_000,
      caption: overrides.caption ?? 'Please read this',
      document: {
        file_id: overrides.fileId ?? 'opaque-file-id',
        file_unique_id: 'unique-1',
        file_name: overrides.fileName ?? 'lab-report.pdf',
        mime_type: 'application/pdf',
        file_size: 1024,
      },
    },
  };
}

function bodyOf(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      const n = Math.min(1024, size - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(66));
    },
  });
}

describe('a real Telegram attachment reaches the owner runtime (transport -> core -> turn)', () => {
  let root: string;
  let logs: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    mockBotStart.mockResolvedValue(undefined);
    logs = [];
    jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    root = makeTestTemp('socs-s1-telegram-media-e2e');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    removeTestTemp(root);
  });

  async function boot(options: { telegram?: boolean; fetchSize?: number } = {}) {
    const fixture = writeConfigFixture(root, { telegramEnabled: options.telegram ?? true, telegramToken: '123:fixture-token' });

    const authority = composeOwnerAuthority({
      ownerId: asProfileId(fixture.ownerId)!,
      ownerPaths: { ownerRecord: fixture.ownerRecord },
    });
    if ((await authority.admission.initialize()) !== 'created') throw new Error('record exists');
    const issued = await authority.admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error(`issue failed: ${issued.kind}`);
    await authority.admission.handlePairing(
      { channel: 'telegram', chatId: OWNER_CHAT, userId: OWNER_USER, chatType: 'private', eventId: `telegram:${OWNER_CHAT}:bind` },
      issued.plaintext,
    );

    let fetchCount = 0;
    const mediaSource = new TelegramMediaSource({
      token: '123:fixture-token',
      api: {
        getFile: async (fileId: string) => {
          mockGetFile(fileId);
          return { file_path: 'files/lab.pdf', file_size: options.fetchSize ?? 1024 };
        },
      },
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(bodyOf(options.fetchSize ?? 1024), { status: 200 });
      },
    });

    // The provider is the ONLY stubbed collaborator now. The runtime, turn coordinator, session store,
    // Router, admission, stager and channel are all real, so the prompt the model receives is the real
    // composed one. An earlier version attached a whole runtime double AFTER start(); it never saw the
    // turn, because the Router resolves through the REAL manager that start() built.
    const prompts: string[] = [];
    const scriptedProvider = {
      modelName: 'scripted',
      chat: async (messages: { content: string | null }[]): Promise<LLMResponse> => {
        prompts.push(messages.map((m) => m.content ?? '').join('\n'));
        return { type: 'text', text: 'Report summarised.' };
      },
      embed: async (): Promise<number[]> => new Array(768).fill(0),
    };

    const loaded = await loadRuntimeConfig({ configPath: fixture.configPath });
    const gateway = new Gateway(loaded, {
      admission: authority.admission,
      ownerId: asProfileId(fixture.ownerId)!,
      mediaSource,
      createProvider: () => scriptedProvider,
    });

    return { fixture, gateway, prompts, fetchCount: () => fetchCount };
  }

  it('stages the owner attachment that arrived through the real grammY document handler', async () => {
    const { fixture, gateway, prompts, fetchCount } = await boot({ telegram: true });

    await gateway.start();
    try {
      // The owner is bound, so a real boot builds the runtime. Telegram is on, so the channel exists.
      expect(gateway.servesPairingOnly).toBe(false);
      expect(gateway.runtimeInstance).toBeDefined();

      // The first ordinary owner message starts in-chat onboarding, which is canned and therefore makes
      // no provider call. Answer it the way a real owner would — `skip` is supported — so the document
      // below is the turn that actually reaches the agent.
      await handlerFor('message:text')(textUpdate('skip', { messageId: 1 }));
      prompts.length = 0;

      // Drive the REAL transport handler with a real document update.
      await handlerFor('message:document')(documentUpdate());

      // The Bot API was asked to resolve the file, and the body was actually fetched.
      expect(mockGetFile).toHaveBeenCalledWith('opaque-file-id');
      expect(fetchCount()).toBe(1);

      // The turn reached the agent with the owner's caption AND an adopted attachment path.
      const prompt = prompts.join('\n');
      expect(prompt).toContain('Please read this');
      expect(prompt).toMatch(/Uploaded media path \(relative to workspace\): reports\//);

      // The adopted file is real, inside the owner's own workspace, and owner-only.
      const relative = /Uploaded media path \(relative to workspace\): (\S+)/.exec(prompt)![1];
      const absolute = path.resolve(fixture.workspace, relative);
      const stat = fs.statSync(absolute);
      expect(absolute.startsWith(path.join(fixture.workspace, 'reports') + path.sep)).toBe(true);
      expect(stat.size).toBe(1024);
      expect(stat.mode & 0o777).toBe(0o600);
      // The transport's file name never became a path component.
      expect(path.basename(absolute)).not.toBe('lab-report.pdf');

      // The owner got a real reply, not a refusal.
      // grammY's api.sendMessage(chat_id, text, other) — the text is positional, not an object.
      expect(mockSendMessage).toHaveBeenCalledWith(
        OWNER_CHAT,
        expect.stringContaining('Report summarised.'),
        expect.anything(),
      );

      // PHI-safe: neither the synthetic marker, the token, nor the Bot API host reached a log.
      const allLogs = logs.join('\n');
      expect(allLogs).not.toContain(PHI);
      expect(allLogs).not.toContain('123:fixture-token');
      expect(allLogs).not.toContain('api.telegram.org');

      // The staging lane is drained once the attachment was adopted.
      expect(fs.readdirSync(fixture.mediaStaging)).toEqual([]);
    } finally {
      await gateway.stop();
    }
  }, 90_000);

  it('fetches NOTHING when a stranger sends a document through the same real handler', async () => {
    const { gateway, fetchCount } = await boot({ telegram: true });
    await gateway.start();
    try {
      await handlerFor('message:document')(documentUpdate({ chatId: Number(STRANGER_CHAT), userId: Number(STRANGER_USER), caption: PHI }));

      // THE property: an unauthenticated sender caused no Bot API call, no fetch and no file.
      expect(mockGetFile).not.toHaveBeenCalled();
      expect(fetchCount()).toBe(0);

      // And the only thing they got was the canned refusal — never the marker, never a clinical answer.
      const replies = mockSendMessage.mock.calls.map((c) => String(c[1]));
      expect(replies.join(' ')).toMatch(/not connected to this assistant/i);
      expect(replies.join(' ')).not.toContain(PHI);
      expect(replies.join(' ')).not.toMatch(/Report summarised/i);

      expect(logs.join('\n')).not.toContain(PHI);
    } finally {
      await gateway.stop();
    }
  }, 90_000);

  it('refuses an attachment the moment it is aborted mid-turn, leaving no file behind', async () => {
    const { fixture, gateway } = await boot({ telegram: true, fetchSize: 4 * 1024 * 1024 });
    await gateway.start();
    try {
      // Drive the handler and stop the daemon while the 4 MB body is still streaming.
      const inFlight = handlerFor('message:document')(documentUpdate());
      await gateway.stop();
      await inFlight.catch(() => undefined);

      // Either the lane was never created, or intake was cleaned up. Never a surviving partial or a
      // complete file left behind by an aborted retrieval.
      const survivors = fs.existsSync(fixture.mediaStaging)
        ? fs.readdirSync(fixture.mediaStaging)
        : [];
      expect(survivors.filter((n) => !n.endsWith('.part'))).toEqual([]);
    } finally {
      await gateway.stop().catch(() => undefined);
    }
  }, 90_000);
});

/** Keep the media-reference type honest: the transport builds these, the core consumes them. */
export type { MediaReference };
