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
  // Reconnect state for the polling lifecycle. A network blip or a bad token makes bot.start()
  // reject; an unhandled rejection would kill the daemon, so it is caught and retried.
  private running = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 1000;
  private readonly maxReconnectMs = 60_000;
  private startOptions?: PollingOptions;

  /**
   * @param botToken Bot token. Used for polling only.
   *
   * The channel emits an opaque `MediaReference` and never fetches, writes or names a file, so it
   * has no filesystem authority to contain. Containment belongs to `FsMediaStager`.
   */
  constructor(botToken: string) {
    this.bot = new Bot(botToken);
    // grammY's error boundary: errors thrown by handlers or middleware and not caught there would
    // otherwise crash the polling loop. Sanitized via summarizeErrorForLog (PHI-safe).
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
        // Handler errors can carry PHI-bearing user text through grammY's error boundary, so log
        // only the sanitized frame.
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
    // grammY's PollingOptions has no built-in backoff, so reconnect with exponential backoff is
    // handled by startPolling()'s rejection handler.
    this.startOptions = {
      onStart: (info) => console.log(`[telegram] Bot @${info.username} connected`),
    };
    this.startPolling();
  }

  private startPolling(): void {
    if (!this.running) return;
    // bot.start() resolves only on stop(); a rejection is a polling startup failure (network blip,
    // transient 5xx, bad token). Handle it explicitly so it never becomes an unhandled rejection.
    void this.bot.start(this.startOptions).then(
      () => {
        // Clean polling end: reset backoff so a later manual reconnect starts fresh.
        this.reconnectDelayMs = 1000;
      },
      (err: unknown) => {
        // Token redaction is not enough: grammY/Telegram errors can echo message bodies (PHI).
        // summarizeErrorForLog excludes the message body.
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
