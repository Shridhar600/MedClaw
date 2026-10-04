// tests/profiles/owner-admission-routing.test.ts
//
// The S1 access grant, proved through the real `GatewayMessageRouter` with the real
// `OwnerAdmissionService`, a real file-backed record and the real code port.
//
// This suite is the direct answer to the captured RED: a stranger DM used to be paired to the
// owner on first contact and answered with a clinical turn. Nothing here stubs admission, the
// router's routing, or the record — the only controlled input is the clock.

import * as fs from 'fs';
import * as path from 'path';

import type { EffectiveConfig } from '../../src/config/types';
import type { IncomingMessage } from '../../src/channels/types';
import type { ProfileRuntime } from '../../src/gateway/runtime';
import { GatewayMessageRouter } from '../../src/gateway/router';
import { CryptoPairingCodePort, FileOwnerStatePort } from '../../src/runtime/adapters';
import {
  OwnerAdmissionService,
  asProfileId,
  resolveOwnerPaths,
} from '../../src/profiles';
import type { OwnerStatePort } from '../../src/ports/owner-state';
import type { Clock } from '../../src/ports/clock';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { fixtureOwner, ownerSelection } from '../helpers/test-config';

const OWNER_ID = 'default';
const START = new Date('2026-05-04T09:00:00.000Z');

class FixedClock implements Clock {
  constructor(private instant: Date = START) {}
  now(): Date {
    return new Date(this.instant);
  }
}

/** A Gateway turn, counted. Reaching this is the whole defect, so it is never mocked away. */
interface TurnCounter {
  runtime: ProfileRuntime;
  prompts: string[];
  replies: string[];
}

function ownerConfig(root: string): { config: EffectiveConfig; workspace: string; storePath: string; audit: string } {
  const owner = fixtureOwner(root);
  const config = {
    schemaVersion: 2,
    ...ownerSelection(owner),
    providers: {
      main: { type: 'ollama', model: 'test-main' },
      medical: { type: 'ollama', model: 'test-medical' },
      embeddings: { type: 'ollama', model: 'test-embeddings' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: owner.workspace,
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20_000,
    },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
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
        quietHours: { enabled: false, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 60,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 5, disclaimerEnabled: false },
  } as EffectiveConfig;
  return { config, workspace: owner.workspace, storePath: owner.storePath, audit: owner.auditLogPath };
}

function turnCounter(config: EffectiveConfig, workspace: string): TurnCounter {
  const prompts: string[] = [];
  const replies: string[] = [];
  const runtime = {
    profileId: OWNER_ID,
    workspace,
    config,
    sessions: {
      recordTurn: async (...args: unknown[]) => {
        // Both arguments are read only to prove a transcript write happened at all.
        void args;
        prompts.push(`recorded:${args.length}`);
      },
    },
    capturePipeline: { ingest: async () => {} },
    trackBackgroundOperation: (_label: string, op: () => Promise<void>) => { void op(); },
    turnCoordinator: {
      runUser: async (_incoming: IncomingMessage, egress: (text: string) => Promise<void>) => {
        prompts.push('clinical-turn');
        await egress('Here is a clinical answer.');
        return 'Here is a clinical answer.';
      },
    },
  } as unknown as ProfileRuntime;
  return { runtime, prompts, replies };
}

function telegramMessage(overrides: Partial<IncomingMessage> & { text: string }): IncomingMessage {
  const chatId = overrides.chatId ?? 'chat-1';
  const messageId = overrides.messageId ?? '1';
  return {
    chatId,
    userId: overrides.userId ?? 'user-1',
    text: overrides.text,
    channel: overrides.channel ?? 'telegram',
    chatType: overrides.chatType ?? 'private',
    eventId: overrides.eventId ?? `telegram:${chatId}:${messageId}`,
    ...(overrides.messageId ? { messageId: overrides.messageId } : {}),
  };
}

describe('S1 routing: admission replaces the first-contact grant', () => {
  let root: string;
  let config: EffectiveConfig;
  let workspace: string;
  let store: OwnerStatePort;
  let admission: OwnerAdmissionService;
  let counter: TurnCounter;
  let router: GatewayMessageRouter;
  let sent: string[];

  beforeEach(async () => {
    root = makeTestTemp('socs-s1-routing');
    ({ config, workspace } = ownerConfig(root));
    const paths = resolveOwnerPaths(root, asProfileId(OWNER_ID)!);
    store = new FileOwnerStatePort(paths.ownerRecord, OWNER_ID);
    admission = new OwnerAdmissionService({
      store,
      codes: new CryptoPairingCodePort(),
      clock: new FixedClock(),
      expectedOwnerId: OWNER_ID,
    });
    await admission.initialize();

    counter = turnCounter(config, workspace);
    sent = [];
    router = new GatewayMessageRouter({
      config,
      runtime: counter.runtime,
      admission,
      ownerId: asProfileId(OWNER_ID)!,
      stagingDir: path.join(root, 'staging'),
      buildBootStatusText: () => 'status',
    });
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  const send = (message: IncomingMessage) => router.route(message, async (text) => { sent.push(text); });

  it('refuses a stranger and never reaches a clinical turn (the captured RED)', async () => {
    const reply = await send(telegramMessage({
      chatId: 'stranger-chat',
      userId: 'stranger-user',
      messageId: '5',
      text: 'What is my blood pressure?',
    }));

    expect(counter.prompts).toEqual([]);
    expect(sent.join(' ')).not.toMatch(/clinical/i);
    expect(reply).toMatch(/private health assistant for one person/i);
    // And nothing about the stranger is written into the owner's record.
    const read = store.read();
    expect(read.kind === 'available' ? read.state.phase : 'unreadable').toBe('unpaired');
  });

  it('answers an unpaired chat with the pairing prompt and no clinical turn', async () => {
    const reply = await send(telegramMessage({ text: 'hello?' }));

    expect(counter.prompts).toEqual([]);
    expect(reply).toMatch(/pairing code/i);
  });

  it('binds on a correct code, then serves the owner chat as the owner', async () => {
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    const pairingReply = await send(telegramMessage({ text: issued.plaintext }));
    expect(pairingReply).toMatch(/pairing complete/i);
    expect(counter.prompts).toEqual([]);

    // The very next ordinary owner message is captured, not swallowed by onboarding.
    const ownerReply = await send(telegramMessage({ chatId: 'chat-1', userId: 'user-1', messageId: '2', text: 'note: slept badly' }));

    expect(counter.prompts).toEqual(['clinical-turn']);
    expect(ownerReply).toBe('Here is a clinical answer.');
  });

  it('gives a stranger only a generic refusal once the owner is bound, never enrollment', async () => {
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    await send(telegramMessage({ text: issued.plaintext }));
    counter.prompts.length = 0;

    const reply = await send(telegramMessage({
      chatId: 'stranger-chat',
      userId: 'stranger-user',
      messageId: '7',
      text: issued.plaintext,
    }));

    expect(reply).toMatch(/not connected to this assistant/i);
    expect(reply).not.toMatch(/pairing code shown/i);
    expect(counter.prompts).toEqual([]);
  });

  it('answers a replayed pairing event with pairing-complete rather than a clinical turn', async () => {
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    await send(telegramMessage({ text: issued.plaintext }));
    counter.prompts.length = 0;

    const reply = await send(telegramMessage({ text: issued.plaintext }));

    expect(reply).toMatch(/pairing complete/i);
    expect(counter.prompts).toEqual([]);
  });

  it('treats the owner\'s own eight-letter health words as narrative, not as a pairing code', async () => {
    // The pairing alphabet is 32 symbols wide, so ordinary eight-letter health words satisfy
    // "eight characters from the alphabet". The router used to test exactly that and answered
    // "pairing complete" — so these messages were never answered, never recorded and never shown to
    // the model. Each one below is a real symptom a real owner would type.
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    await send(telegramMessage({ text: issued.plaintext }));

    const healthWords = ['headache', 'insomnia', 'diabetes', 'swelling'];
    for (const [index, word] of healthWords.entries()) {
      counter.prompts.length = 0;
      const reply = await send(telegramMessage({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: `w${index}`,
        text: word,
      }));

      // It must be a real clinical turn, answered by the agent — not a pairing acknowledgement.
      expect(reply).toBe('Here is a clinical answer.');
      expect(reply).not.toMatch(/pairing complete/i);
      expect(counter.prompts).toEqual(['clinical-turn']);
    }
  });

  it('refuses group traffic even when the chat is the owner chat', async () => {
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    await send(telegramMessage({ text: issued.plaintext }));
    counter.prompts.length = 0;

    const reply = await send(telegramMessage({ chatType: 'group', text: 'group note' }));

    expect(reply).toMatch(/not connected to this assistant/i);
    expect(counter.prompts).toEqual([]);
  });

  it('refuses a message that carries no transport identity', async () => {
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    await send(telegramMessage({ text: issued.plaintext }));
    counter.prompts.length = 0;

    const reply = await send({ chatId: 'chat-1', userId: 'user-1', text: issued.plaintext });

    expect(reply).toMatch(/not connected to this assistant/i);
    expect(counter.prompts).toEqual([]);
  });

  it('keeps an unpaired emergency canned, provider-free and unpersisted', async () => {
    const reply = await send(telegramMessage({
      chatId: 'stranger-chat',
      userId: 'stranger-user',
      messageId: '9',
      text: 'I think I am having chest pain, is it serious?',
    }));

    expect(reply).toMatch(/emergency|call|urgent|911|999/i);
    expect(counter.prompts).toEqual([]);
    // Nothing about an unpaired chat reaches owner content: no transcript, no capture, and the
    // record is still unpaired. (The `.state` directory itself exists — that is where the owner
    // RECORD lives, created by setup, and is not evidence of persistence.)
    expect(fs.existsSync(path.join(workspace, '.state', 'sessions'))).toBe(false);
    const read = store.read();
    expect(read.kind === 'available' && read.state.phase).toBe('unpaired');
  });

  it('records an admitted owner emergency into the owner transcript', async () => {
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    await send(telegramMessage({ text: issued.plaintext }));
    counter.prompts.length = 0;

    await send(telegramMessage({ messageId: '3', text: 'I think I am having chest pain' }));

    expect(counter.prompts).toEqual(['recorded:2']);
  });

  it('does not consume a pairing attempt for a group message carrying the right code', async () => {
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    await send(telegramMessage({ chatType: 'group', chatId: 'group-1', messageId: '4', text: issued.plaintext }));

    const read = store.read();
    const chats = read.kind === 'available' && read.state.phase === 'unpaired'
      ? read.state.attempts.chats
      : [];
    expect(chats).toEqual([]);
  });
});

describe('S1 routing: a group message never gains health state even when text looks clinical', () => {
  it('refuses before the emergency detector can produce owner content', async () => {
    const root = makeTestTemp('socs-s1-group');
    try {
      const { config, workspace } = ownerConfig(root);
      const paths = resolveOwnerPaths(root, asProfileId(OWNER_ID)!);
      const store = new FileOwnerStatePort(paths.ownerRecord, OWNER_ID);
      const admission = new OwnerAdmissionService({
        store,
        codes: new CryptoPairingCodePort(),
        clock: new FixedClock(),
        expectedOwnerId: OWNER_ID,
      });
      await admission.initialize();

      const counter = turnCounter(config, workspace);
      const router = new GatewayMessageRouter({
        config,
        runtime: counter.runtime,
        admission,
        ownerId: asProfileId(OWNER_ID)!,
        stagingDir: path.join(root, 'staging'),
        buildBootStatusText: () => 'status',
      });

      const reply = await router.route(
        telegramMessage({ chatType: 'supergroup', chatId: 'group-9', messageId: '11', text: 'what should we discuss about my diabetes?' }),
        async () => undefined,
      );

      expect(counter.prompts).toEqual([]);
      expect(reply).not.toMatch(/diabetes/i);
    } finally {
      removeTestTemp(root);
    }
  });
});