// tests/gateway/gateway-media-admission.test.ts
//
// B2 end to end: a real attachment travelling the real inbound path.
//
// THE INVARIANT: attachment bytes are fetched ONLY for an admitted owner, they land in the SELECTED
// OWNER's staging lane, and a stranger's attachment causes no retrieval at all.
//
// This suite exists because the media path was unreachable in production. `handleMessage` (the Telegram
// callback) called `route()` directly and never `admitAndStage`, `deliverMessage` had no `src/` caller,
// and no `MediaSourcePort` implementation existed anywhere in `src/`. Meanwhile the transport substituted
// placeholder text ("Sent a photo") that reached the model as if it were the whole message. Every earlier
// media test proved the stager or the channel in isolation; none proved the composed path.
//
// Collaborators are all real except the two external edges, which is the only legitimate seam:
//   - `TelegramFileApi.getFile` is faked (Bot API resolution)
//   - the HTTP fetch is faked (the file body)
// Nothing here mocks admission, the Router, `FsMediaStager` or `Gateway`.

import * as fs from 'fs';
import * as path from 'path';

import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import { attachGatewayTestRuntime } from '../helpers/gateway-test-runtime';
import { TelegramMediaSource } from '../../src/channels/telegram-media-source';
import type { MediaReference } from '../../src/ports/media-source';
import { composeOwnerAuthority } from '../../src/runtime/owner-authority';
import { asProfileId } from '../../src/profiles';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';

const OWNER_CHAT = 'owner-chat';
const OWNER_USER = 'owner-user';

function documentReference(overrides: Partial<MediaReference> = {}): MediaReference {
  return {
    channel: 'telegram',
    fileId: 'opaque-file-id-1',
    kind: 'document',
    displayName: 'lab-report.pdf',
    mime: 'application/pdf',
    ...overrides,
  };
}

/** A body of `size` bytes delivered in `chunkSize` pieces, so the cap is enforced WHILE streaming. */
function bodyOf(size: number, chunkSize = 4096): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, size - sent);
      const chunk = new Uint8Array(n).fill(65);
      sent += n;
      controller.enqueue(chunk);
    },
  });
}

describe('admitted media reaches the owner runtime through the real inbound path', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-media-admission');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  /** A bound owner plus a real Gateway whose media source is a real TelegramMediaSource. */
  async function bootBoundGateway(opts: {
    fileSize?: number;
    getFileImpl?: (fileId: string) => Promise<{ file_path?: string; file_size?: number }>;
  } = {}) {
    const fixture = writeConfigFixture(root, { telegramEnabled: false });

    // Bind through the real admission service: initialize -> issue -> submit the real code.
    const authority = composeOwnerAuthority({
      ownerId: asProfileId(fixture.ownerId)!,
      ownerPaths: { ownerRecord: fixture.ownerRecord },
    });
    if ((await authority.admission.initialize()) !== 'created') throw new Error('record exists');
    const issued = await authority.admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error(`issue failed: ${issued.kind}`);
    await authority.admission.handlePairing(
      { channel: 'telegram', chatId: OWNER_CHAT, userId: OWNER_USER, chatType: 'private', eventId: 'telegram:owner-chat:p1' },
      issued.plaintext,
    );

    const fetched: string[] = [];
    const mediaSource = new TelegramMediaSource({
      token: 'test-token',
      api: { getFile: opts.getFileImpl ?? (async () => ({ file_path: 'files/lab.pdf', file_size: opts.fileSize })) },
      fetchImpl: async () => {
        fetched.push('called');
        return new Response(bodyOf(opts.fileSize ?? 2048), { status: 200 });
      },
    });

    const loaded = await loadRuntimeConfig({ configPath: fixture.configPath });
    const gateway = new Gateway(loaded, {
      admission: authority.admission,
      ownerId: asProfileId(fixture.ownerId)!,
      mediaSource,
    });
    return { fixture, gateway, fetched, loadedConfig: loaded };
  }

  const deliver = (gateway: Gateway, chatId: string, userId: string, eventId: string, text: string, media?: MediaReference) => {
    const sent: string[] = [];
    return gateway
      .deliverMessage(
        { chatId, userId, text, channel: 'telegram', chatType: 'private', eventId, ...(media ? { media } : {}) },
        async (reply) => { sent.push(reply); },
      )
      .then(() => sent);
  };

  /** Prompts the agent actually received, so assertions read the real composed input. */
  let agentPrompts: string[] = [];
  const agentInput = (): string[] => agentPrompts;

  /**
   * What the staged attachment looked like at the exact moment the model was handed it.
   *
   * The staged file is deliberately cleaned up once the turn ends, so asserting on it AFTER
   * `deliverMessage` returns proves nothing. Sampling from inside the agent call observes the real file
   * at the only moment it is supposed to exist.
   */
  let seenByAgent: { path: string; size: number; mode: number } | undefined;

  /**
   * Give the admitted turn somewhere to go. This is the project's established test-double seam, and it
   * is the ONLY collaborator stubbed: admission, the Router, `FsMediaStager`, `TelegramMediaSource` and
   * `Gateway` are all real. Onboarding is switched off so the assertion is about the media path rather
   * than about which turn happens to come first.
   */
  function attachAgent(gateway: Gateway, loadedConfig: EffectiveConfig, replyText: string, workspace: string): void {
    agentPrompts = [];
    agentPrompts = [];
    seenByAgent = undefined;
    const run = jest.fn().mockImplementation(async (input: string) => {
      agentPrompts.push(input);
      // The prompt carries the adopted attachment as a path RELATIVE to the owner's workspace, so it is
      // resolved against the workspace in order to observe the real file.
      const match = /Uploaded media path \(relative to workspace\): (\S+)/.exec(input);
      if (match) {
        const absolute = path.resolve(workspace, match[1]);
        const stat = fs.statSync(absolute);
        seenByAgent = { path: absolute, size: stat.size, mode: stat.mode & 0o777 };
      }
      return { text: replyText, trace: [{ role: 'assistant', content: replyText }], usedTools: [], healthResponse: false };
    });
    attachGatewayTestRuntime(gateway, loadedConfig as unknown as EffectiveConfig, {
      agentLoop: { run },
      sessions: {
        prepareHistory: jest.fn().mockResolvedValue([]),
        recordTurn: jest.fn().mockResolvedValue(undefined),
        resetSession: jest.fn(),
      },
    });
    // Onboarding is a real multi-step flow; this suite is about the media path, so it is switched off
    // so the assertions read the agent turn rather than whichever turn happens to come first.
    const runtime = (gateway as unknown as { runtime: { turnCoordinator: { handleOnboarding: unknown } } }).runtime;
    runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
  }

  it('stages an admitted owner attachment into the owner lane and tells the user it worked', async () => {
    const { fixture, gateway, fetched, loadedConfig } = await bootBoundGateway({ fileSize: 2048 });

    attachAgent(gateway, loadedConfig, 'I read the report.', fixture.workspace);

    const replies = await deliver(gateway, OWNER_CHAT, OWNER_USER, 'telegram:owner-chat:m1', 'Please read this', documentReference());

    // The external edge was actually used — this is not a no-op path.
    expect(fetched).toEqual(['called']);

    // The attachment was retrieved, staged, then ADOPTED into the owner's own workspace under
    // `reports/` with a generated name — the transport's `displayName` never became a path component.
    expect(seenByAgent).toBeDefined();
    expect(seenByAgent!.path.startsWith(path.join(fixture.workspace, 'reports') + path.sep)).toBe(true);
    expect(path.basename(seenByAgent!.path)).not.toBe('lab-report.pdf');
    // Real byte count measured from the stream, not the transport's claim, and owner-only permissions.
    expect(seenByAgent!.size).toBe(2048);
    expect(seenByAgent!.mode).toBe(0o600);

    // The turn ran, so the owner was actually served rather than refused, and the model received the
    // owner's own words alongside the attachment path.
    expect(agentInput().join('\n')).toContain('Please read this');
    expect(replies.join(' ')).toContain('I read the report.');
    expect(replies.join(' ')).not.toMatch(/temporarily unavailable/i);

    // The staging lane is drained once the attachment is adopted: nothing is left lying around.
    expect(fs.readdirSync(fixture.mediaStaging)).toEqual([]);
  }, 60_000);

  it('causes NO retrieval for a stranger attachment, and says only a refusal', async () => {
    const { gateway, fetched } = await bootBoundGateway({ fileSize: 2048 });

    const replies = await deliver(
      gateway, 'stranger-chat', 'stranger-user', 'telegram:stranger-chat:m1',
      'look at this', documentReference({ fileId: 'stranger-file' }),
    );

    // THE security property: nothing was fetched, staged or buffered on a stranger's behalf.
    expect(fetched).toEqual([]);

    const joined = replies.join(' ');
    expect(joined).toMatch(/not connected to this assistant/i);
    // Critically: the placeholder text must never be echoed as if it were the message.
    expect(joined).not.toMatch(/Sent a photo|Uploaded:/i);
  }, 60_000);

  it('refuses an owner attachment whose real bytes exceed the cap, without handing a file onward', async () => {
    // The transport claims a small file and then sends far more — the cap must be enforced while
    // streaming, not from the claim.
    const { fixture, gateway, loadedConfig } = await bootBoundGateway({
      fileSize: 12 * 1024 * 1024,
      getFileImpl: async () => ({ file_path: 'files/big.pdf', file_size: 1024 }),
    });

    attachAgent(gateway, loadedConfig, 'ok', fixture.workspace);

    const replies = await deliver(gateway, OWNER_CHAT, OWNER_USER, 'telegram:owner-chat:m2', 'big one', documentReference({ advertisedBytes: 1024 }));

    const joined = replies.join(' ');
    expect(joined).toMatch(/10 MB limit|larger than/i);
    // The model was never handed a path, so an over-cap stream cannot become a usable attachment.
    expect(seenByAgent).toBeUndefined();
    // No staged file survived, and no partial was left behind.
    expect(fs.readdirSync(fixture.mediaStaging)).toEqual([]);
  }, 60_000);
});
