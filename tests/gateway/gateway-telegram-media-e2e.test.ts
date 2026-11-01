
import * as fs from 'fs';
import * as path from 'path';

import type { LLMResponse } from '../../src/providers/types';

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

import { Gateway } from '../../src/gateway';
import { TelegramMediaSource } from '../../src/channels';
import { composeOwnerAuthority } from '../../src/runtime';
import { asProfileId } from '../../src/profiles';
import { loadRuntimeConfig } from '../../src/runtime';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';

type Handler = (ctx: unknown) => Promise<void>;

/** The handler the channel registered for a grammY event name. */
function handlerFor(event: string): Handler {
  const call = mockBotOn.mock.calls.find(([name]) => name === event);
  if (!call) throw new Error(`channel never registered ${event}; registered: ${mockBotOn.mock.calls.map(([n]) => n).join(', ')}`);
  return call[1] as Handler;
}

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
    root = makeTestTemp('telegram-media-e2e');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    removeTestTemp(root);
  });

  async function boot(options: {
    telegram?: boolean;
    fetchSize?: number;
    getFileImpl?: (id: string, signal?: AbortSignal) => Promise<{ file_path?: string; file_size?: number }>;
    fetchImpl?: (signal: AbortSignal) => Promise<Response>;
  } = {}) {
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
        getFile: async (fileId: string, signal?: AbortSignal) => {
          mockGetFile(fileId);
          if (options.getFileImpl) return options.getFileImpl(fileId, signal);
          return { file_path: 'files/lab.pdf', file_size: options.fetchSize ?? 1024 };
        },
      },
      fetchImpl: async (_url, signal) => {
        fetchCount += 1;
        if (options.fetchImpl) return options.fetchImpl(signal);
        return new Response(bodyOf(options.fetchSize ?? 1024), { status: 200 });
      },
    });

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
      expect(gateway.servesPairingOnly).toBe(false);
      expect(gateway.runtimeInstance).toBeDefined();

      await handlerFor('message:text')(textUpdate('skip', { messageId: 1 }));
      prompts.length = 0;

      await handlerFor('message:document')(documentUpdate());

      expect(mockGetFile).toHaveBeenCalledWith('opaque-file-id');
      expect(fetchCount()).toBe(1);

      const prompt = prompts.join('\n');
      expect(prompt).toContain('Please read this');
      expect(prompt).toMatch(/Uploaded media path \(relative to workspace\): reports\//);

      const relative = /Uploaded media path \(relative to workspace\): (\S+)/.exec(prompt)![1];
      const absolute = path.resolve(fixture.workspace, relative);
      const stat = fs.statSync(absolute);
      expect(absolute.startsWith(path.join(fixture.workspace, 'reports') + path.sep)).toBe(true);
      expect(stat.size).toBe(1024);
      expect(stat.mode & 0o777).toBe(0o600);
      // The transport's file name never became a path component.
      expect(path.basename(absolute)).not.toBe('lab-report.pdf');

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

      expect(mockGetFile).not.toHaveBeenCalled();
      expect(fetchCount()).toBe(0);

      const replies = mockSendMessage.mock.calls.map((c) => String(c[1]));
      expect(replies.join(' ')).toMatch(/not connected to this assistant/i);
      expect(replies.join(' ')).not.toContain(PHI);
      expect(replies.join(' ')).not.toMatch(/Report summarised/i);

      expect(logs.join('\n')).not.toContain(PHI);
    } finally {
      await gateway.stop();
    }
  }, 90_000);

  it('stop during entered metadata prevents late fetch/write/turn; restart adopts a streamed retry in the same installation', async () => {
    let resolveMetadata!: (file: { file_path: string }) => void;
    const metadata = new Promise<{ file_path: string }>(resolve => { resolveMetadata = resolve; });
    let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    let heldSignal: AbortSignal | undefined;
    const fetchSignals: AbortSignal[] = [];
    const fetchEntryStates: boolean[] = [];
    const { fixture, gateway, prompts } = await boot({
      getFileImpl: async (id, signal) => {
        if (id !== 'held') return { file_path: 'files/allowed', file_size: 1024 };
        heldSignal = signal;
        entered();
        return metadata;
      },
      fetchImpl: async signal => {
        fetchEntryStates.push(signal.aborted);
        fetchSignals.push(signal);
        return new Response(bodyOf(1024));
      },
    });
    const entries = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    const reports = path.join(fixture.workspace, 'reports');
    await gateway.start();
    try {
      await handlerFor('message:text')(textUpdate('skip'));
      await handlerFor('message:document')(documentUpdate({ fileId: 'allowed' }));
      const beforeReports = entries(reports);
      expect(beforeReports).toHaveLength(1);
      const firstBytes = fs.readFileSync(path.join(reports, beforeReports[0]));
      expect(firstBytes).toEqual(Buffer.alloc(1024, 66));
      const beforePrompts = prompts.length;
      const beforeFetches = fetchSignals.length;
      const inFlight = handlerFor('message:document')(documentUpdate({ fileId: 'held' }));
      await entry;
      expect(gateway.shutdownWorkInFlight().turns).toBeGreaterThan(0);
      await gateway.stop();
      await inFlight;
      expect(gateway.getShutdownDisposition()).toBe('quiescent');
      resolveMetadata({ file_path: 'files/late' });
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      const lateFetchStates = fetchEntryStates.slice(beforeFetches);
      expect(entries(fixture.mediaStaging)).toEqual([]);
      expect(entries(reports)).toEqual(beforeReports);
      expect(fs.readFileSync(path.join(reports, beforeReports[0]))).toEqual(firstBytes);
      expect(prompts).toHaveLength(beforePrompts);

      await gateway.start();
      await handlerFor('message:document')(documentUpdate({ fileId: 'retry' }));
      const afterReports = entries(reports);
      expect(afterReports).toHaveLength(2);
      for (const name of afterReports) {
        const artifact = path.join(reports, name);
        expect(fs.readFileSync(artifact)).toEqual(Buffer.alloc(1024, 66));
        expect(fs.statSync(artifact).mode & 0o777).toBe(0o600);
      }
      expect(fs.statSync(fixture.mediaStaging).mode & 0o777).toBe(0o700);
      expect(entries(fixture.mediaStaging)).toEqual([]);
      expect(prompts.length).toBeGreaterThan(beforePrompts);
      expect(lateFetchStates).toEqual([]);
      expect(heldSignal?.aborted).toBe(true);
    } finally {
      resolveMetadata({ file_path: 'files/late' });
      await gateway.stop();
    }
  }, 90_000);

  it('refuses an owner attachment whose real bytes exceed the cap, without handing a file onward', async () => {
    const { fixture, gateway, prompts } = await boot({ fetchSize: 12 * 1024 * 1024, getFileImpl: async () => ({ file_path: 'files/big.pdf', file_size: 1024 }) });
    await gateway.start();
    try {
      await handlerFor('message:text')(textUpdate('skip'));
      prompts.length = 0;

      await handlerFor('message:document')(documentUpdate());

      const replies = mockSendMessage.mock.calls.map((c) => String(c[1])).join(' ');
      expect(replies).toMatch(/10 MB limit|larger than/i);
      expect(prompts).toEqual([]);
      expect(fs.readdirSync(fixture.mediaStaging)).toEqual([]);
      expect(fs.existsSync(path.join(fixture.workspace, 'reports')) ? fs.readdirSync(path.join(fixture.workspace, 'reports')) : []).toEqual([]);
    } finally {
      await gateway.stop();
    }
  }, 90_000);
});
