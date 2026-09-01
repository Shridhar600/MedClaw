import { Bot, type PollingOptions } from 'grammy';
import * as path from 'path';
import * as crypto from 'crypto';
import { secureMkdir, secureWrite, summarizeErrorForLog } from '../security';
import type { Channel, IncomingMessage, OutgoingMessage } from './types';

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  private workspacePath: string;
  // Reconnect state for the polling long-poll lifecycle. Network blips or a
  // bad/expired token make bot.start() reject; without an explicit .catch the
  // rejected promise becomes an unhandledRejection and the daemon dies (RES-P0-2).
  private running = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 1000;
  private readonly maxReconnectMs = 60_000;
  private startOptions?: PollingOptions;

  constructor(botToken: string, workspacePath: string) {
    this.bot = new Bot(botToken);
    this.workspacePath = workspacePath;
    // grammY's error boundary: any error thrown by handlers/middleware that is
    // not caught inside the handler lands here. Without it, such errors crash
    // the polling loop (RES-P0-1). Sanitized via summarizeErrorForLog (PHI bind).
    this.bot.catch((botError) => {
      console.error('[telegram] Bot error boundary:', summarizeErrorForLog(botError));
    });
  }

  private sanitizeFileName(fileName: string): string {
    return fileName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\./g, '');
  }

  private async downloadFile(fileId: string, fileName: string): Promise<string> {
    const file = await this.bot.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const reportsDir = path.join(this.workspacePath, 'reports');
    secureMkdir(reportsDir);
    const safeFileName = this.sanitizeFileName(fileName);
    const relativePath = path.join('reports', `${Date.now()}-${crypto.randomUUID()}-${safeFileName}`);
    const savePath = path.join(this.workspacePath, relativePath);
    secureWrite(savePath, buffer);
    return relativePath.split(path.sep).join('/');
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

      let mediaPath: string | undefined;
      let mediaError: string | undefined;
      try {
        mediaPath = await this.downloadFile(fileId, fileName);
      } catch (e) {
        console.error('[telegram] Failed to download document:', summarizeErrorForLog(e));
        mediaError = `Failed to download uploaded file ${fileName}. Please try uploading it again.`;
      }

      try {
        await this.messageHandler({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ''),
          text: ctx.message.caption ?? `Uploaded: ${fileName}`,
          mediaPath,
          mediaError,
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

      let mediaPath: string | undefined;
      let mediaError: string | undefined;
      try {
        mediaPath = await this.downloadFile(fileId, fileName);
      } catch (e) {
        console.error('[telegram] Failed to download photo:', summarizeErrorForLog(e));
        mediaError = 'Failed to download uploaded photo. Please try sending it again.';
      }

      try {
        await this.messageHandler({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ''),
          text: ctx.message.caption ?? 'Sent a photo',
          mediaPath,
          mediaError,
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
