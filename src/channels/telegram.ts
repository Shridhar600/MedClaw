import { Bot, type PollingOptions } from 'grammy';
import { summarizeErrorForLog } from '../security';
import type { Channel, ChatType, IncomingMessage, OutgoingMessage } from './types';

export const TELEGRAM_CHANNEL_NAME = 'telegram';

/** Stable across a Telegram redelivery, so a retry cannot spend a second pairing attempt. */
export function telegramEventId(chatId: number | string, messageId: number | string): string {
  return `${TELEGRAM_CHANNEL_NAME}:${chatId}:${messageId}`;
}

/**
 * grammY reports the chat kind; anything it does not recognise is treated as a non-private chat,
 * because the safe failure for admission is "not one-to-one".
 */
export function telegramChatType(raw: string): ChatType {
  switch (raw) {
    case 'private':
      return 'private';
    case 'group':
      return 'group';
    case 'supergroup':
      return 'supergroup';
    case 'channel':
      return 'channel';
    default:
      return 'group';
  }
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  // Reconnect state for the polling long-poll lifecycle. Network blips or a
  // bad/expired token make bot.start() reject; without an explicit .catch the
  // rejected promise becomes an unhandledRejection and the daemon dies (RES-P0-2).
  private running = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 1000;
  private readonly maxReconnectMs = 60_000;
  private startOptions?: PollingOptions;

  /**
   * @param botToken Bot token. Used for polling only.
   *
   * There is deliberately no staging path and no trusted-base argument any more. The channel emits an
   * opaque `MediaReference` and never fetches, writes or names a file, so it has no filesystem
   * authority to contain. Containment belongs to `FsMediaStager`, which is constructed once by the
   * Gateway against the selected owner's lane. The old `stagingPath`/`trustedStagingBase` pair existed
   * solely for `downloadFile`, which buffered the whole body with `arrayBuffer()` and was dead code.
   */
  constructor(botToken: string) {
    this.bot = new Bot(botToken);
    // grammY's error boundary: any error thrown by handlers/middleware that is
    // not caught inside the handler lands here. Without it, such errors crash
    // the polling loop (RES-P0-1). Sanitized via summarizeErrorForLog (PHI bind).
    this.bot.catch((botError) => {
      console.error('[telegram] Bot error boundary:', summarizeErrorForLog(botError));
    });
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;

    this.bot.on('message:text', async (ctx) => {
      if (!this.messageHandler) return;
      try {
        await this.messageHandler({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ''),
          text: ctx.message.text,
          channel: TELEGRAM_CHANNEL_NAME,
          chatType: telegramChatType(ctx.chat.type),
          eventId: telegramEventId(ctx.chat.id, ctx.message.message_id),
          messageId: String(ctx.message.message_id),
          replyToMessageId: ctx.message.reply_to_message?.message_id
            ? String(ctx.message.reply_to_message.message_id)
            : undefined,
        });
      } catch (e) {
        // Handler errors propagate PHI-bearing user text through grammY's error
        // boundary — log the sanitized frame only here (the boundary at
        // construction also sanitizes). Token redaction is retained for the
        // download-error logs below; handler errors carry no token URL.
        console.error('[telegram] Handler error:', summarizeErrorForLog(e));
        throw e; // allow grammY to retry
      }
    });

    // Handle document/photo uploads (medical reports)
    this.bot.on('message:document', async (ctx) => {
      if (!this.messageHandler) return;
      const document = ctx.message.document;
      const fileId = document.file_id;
      const fileName = document.file_name ?? 'document';

      // METADATA ONLY. No `getFile`, no remote fetch, no local write happens here: an unauthenticated
      // sender must not be able to make this process download or store anything. The core asks the
      // injected media source for bytes only after admission.
      try {
        await this.messageHandler({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ''),
          text: ctx.message.caption ?? `Uploaded: ${fileName}`,
          channel: TELEGRAM_CHANNEL_NAME,
          chatType: telegramChatType(ctx.chat.type),
          eventId: telegramEventId(ctx.chat.id, ctx.message.message_id),
          messageId: String(ctx.message.message_id),
          media: {
            channel: TELEGRAM_CHANNEL_NAME,
            fileId,
            kind: 'document',
            displayName: fileName,
            mime: document.mime_type ?? undefined,
            // `file_size` is the transport's claim. It is inspected, never trusted as the cap.
            advertisedBytes: typeof document.file_size === 'number' ? document.file_size : undefined,
          },
          replyToMessageId: ctx.message.reply_to_message?.message_id
            ? String(ctx.message.reply_to_message.message_id)
            : undefined,
        });
      } catch (e) {
        console.error('[telegram] Handler error:', summarizeErrorForLog(e));
        throw e; // allow grammY to retry
      }
    });

    this.bot.on('message:photo', async (ctx) => {
      if (!this.messageHandler) return;
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const fileId = photo.file_id;
      const fileName = `photo-${fileId}.jpg`;

      // METADATA ONLY, same reason as the document handler above.
      try {
        await this.messageHandler({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ''),
          text: ctx.message.caption ?? 'Sent a photo',
          channel: TELEGRAM_CHANNEL_NAME,
          chatType: telegramChatType(ctx.chat.type),
          eventId: telegramEventId(ctx.chat.id, ctx.message.message_id),
          messageId: String(ctx.message.message_id),
          media: {
            channel: TELEGRAM_CHANNEL_NAME,
            fileId,
            kind: 'photo',
            displayName: fileName,
            advertisedBytes: typeof photo.file_size === 'number' ? photo.file_size : undefined,
          },
          replyToMessageId: ctx.message.reply_to_message?.message_id
            ? String(ctx.message.reply_to_message.message_id)
            : undefined,
        });
      } catch (e) {
        console.error('[telegram] Handler error:', summarizeErrorForLog(e));
        throw e;
      }
    });
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    await this.bot.api.sendMessage(chatId, message.text, {
      parse_mode: message.parseMode ?? 'Markdown',
      reply_parameters: message.replyToMessageId
        ? { message_id: Number(message.replyToMessageId) }
        : undefined,
    });
  }

  async connect(): Promise<void> {
    console.log('[telegram] Starting bot polling...');
    this.running = true;
    // grammY 1.42.0 PollingOptions exposes limit/timeout/allowed_updates/
    // drop_pending_updates/onStart — there is no built-in polling backoff field,
    // so reconnect-with-exponential-backoff is handled by startPolling()'s
    // rejection handler below (RES-P0-2 + RES-P2-4).
    this.startOptions = {
      onStart: (info) => console.log(`[telegram] Bot @${info.username} connected`),
    };
    this.startPolling();
  }

  private startPolling(): void {
    if (!this.running) return;
    // bot.start() resolves only on stop(); a rejection here is a polling
    // startup failure (network blip, transient 5xx, bad token). Attach an
    // explicit rejection handler so it never becomes an unhandledRejection.
    void this.bot.start(this.startOptions).then(
      () => {
        // Clean polling end: reset backoff so a later manual reconnect starts
        // fresh. On shutdown `running` is already false.
        this.reconnectDelayMs = 1000;
      },
      (err: unknown) => {
        // Token-redaction is NOT enough — grammY/Telegram errors can echo full
        // message bodies (PHI). summarizeErrorForLog excludes the message body.
        console.warn('[telegram] Polling start failed:', summarizeErrorForLog(err));
        if (!this.running) return;
        this.scheduleReconnect();
      },
    );
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectMs);
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.startPolling();
    }, delay);
    // Never keep the event loop alive solely for a reconnect attempt.
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.bot.stop();
  }
}
