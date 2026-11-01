import { Bot, type PollingOptions } from 'grammy';
import { summarizeErrorForLog } from '../security';
import type { Channel, ChatType, IncomingMessage, OutgoingMessage } from './types';

export const TELEGRAM_CHANNEL_NAME = 'telegram';

/** Stable across a Telegram redelivery, so a retry cannot spend a second pairing attempt. */
export function telegramEventId(chatId: number | string, messageId: number | string): string {
  return `${TELEGRAM_CHANNEL_NAME}:${chatId}:${messageId}`;
}

/** Unknown kinds fall back to a non-private chat: admission fails closed. */
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

// No filesystem authority: containment belongs to `FsMediaStager`.
export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  // A rejected start() would kill the daemon, so it is caught and retried.
  private running = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 1000;
  private readonly maxReconnectMs = 60_000;
  private startOptions?: PollingOptions;

  constructor(botToken: string) {
    this.bot = new Bot(botToken);
    // Uncaught handler errors would crash the polling loop; log sanitized.
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
        // Handler errors can carry PHI; log the sanitized frame only.
        console.error('[telegram] Handler error:', summarizeErrorForLog(e));
        throw e; // allow grammY to retry
      }
    });

    this.bot.on('message:document', async (ctx) => {
      if (!this.messageHandler) return;
      const document = ctx.message.document;
      const fileId = document.file_id;
      const fileName = document.file_name ?? 'document';

      // Metadata only: an unauthenticated sender must never make this process fetch or store bytes.
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
            // The transport's size claim is never trusted as the cap.
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

      // Metadata only, same as the document handler.
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
    const reply_parameters = message.replyToMessageId
      ? { message_id: Number(message.replyToMessageId) }
      : undefined;
    try {
      await this.bot.api.sendMessage(chatId, message.text, {
        parse_mode: message.parseMode ?? 'Markdown',
        reply_parameters,
      });
    } catch (e) {
      // Unbalanced model Markdown: resend the same words unformatted.
      if (!/can't parse entities/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await this.bot.api.sendMessage(chatId, message.text, { reply_parameters });
    }
  }

  async connect(): Promise<void> {
    console.log('[telegram] Starting bot polling...');
    this.running = true;
    // Backoff is handled by the rejection handler below; PollingOptions has none.
    this.startOptions = {
      onStart: (info) => console.log(`[telegram] Bot @${info.username} connected`),
    };
    this.startPolling();
  }

  private startPolling(): void {
    if (!this.running) return;
    // start() resolves only on stop(); a rejection is a startup failure, not an unhandled crash.
    void this.bot.start(this.startOptions).then(
      () => {
        // Clean end: reset the backoff.
        this.reconnectDelayMs = 1000;
      },
      (err: unknown) => {
        // Errors can echo message bodies (PHI); summarizeErrorForLog drops them.
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
