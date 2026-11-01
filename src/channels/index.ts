// The transport boundary. This file is the only import surface for other modules; everything else in
// `channels/` is private.
//
// A channel is an edge adapter: it turns bytes from a transport into a normalized `IncomingMessage`
// and sends an `OutgoingMessage` back. It must not know about owner admission, health policy,
// sessions, memory or the filesystem layout. A channel hands over an opaque `MediaReference` (never
// bytes or a local path) and the core decides admission before anything is fetched.
export type { Channel, ChatType, IncomingMessage, OutgoingMessage, AdmittedMessage } from './types';
export { TELEGRAM_CHANNEL_NAME, TelegramChannel, telegramChatType, telegramEventId } from './telegram';
export { TelegramMediaSource } from './telegram-media-source';
export type { TelegramFileApi, TelegramFileFetcher, TelegramMediaSourceOptions } from './telegram-media-source';
