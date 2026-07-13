import { Bot } from 'grammy';
import * as path from 'path';
import * as crypto from 'crypto';
import { secureMkdir, secureWrite } from '../security';
import type { Channel, IncomingMessage, OutgoingMessage } from './types';

export function redactTelegramBotTokens(text: string): string {
  return text.replace(
    /(https:\/\/api\.telegram\.org\/(?:file\/)?bot)[^/\s]+/g,
    '$1<redacted>',
  );
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    const name = redactTelegramBotTokens(error.name);
    const message = redactTelegramBotTokens(error.message);
    return `${name}: ${message}`;
  }

  return redactTelegramBotTokens(String(error));
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  private workspacePath: string;

  constructor(botToken: string, workspacePath: string) {
    this.bot = new Bot(botToken);
    this.workspacePath = workspacePath;
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
        console.error('[telegram] Handler error:', e);
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
        console.error('[telegram] Failed to download document:', summarizeError(e));
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
        console.error('[telegram] Handler error:', e);
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
        console.error('[telegram] Failed to download photo:', summarizeError(e));
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
        console.error('[telegram] Handler error:', e);
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
    void this.bot.start({
      onStart: (info) => console.log(`[telegram] Bot @${info.username} connected`),
    });
  }

  async disconnect(): Promise<void> {
    await this.bot.stop();
  }
}
