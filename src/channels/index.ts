// src/channels/index.ts
//
// The transport boundary. This file is the ONLY import surface for other modules: everything else in
// `channels/` is private. A consumer imports from `../channels`, never from `../channels/telegram`.
//
// The rule that matters here is direction. A channel is an EDGE ADAPTER: it turns bytes from a
// transport into a normalized `IncomingMessage` and sends an `OutgoingMessage` back. It must not know
// about owner admission, health policy, sessions, memory, or the filesystem layout — those are core
// decisions, and a transport that made them would let an unauthenticated sender's message decide who
// may read the owner's health data.
//
// In S1 that separation became load-bearing rather than stylistic: a channel now hands over an opaque
// `MediaReference` (an identity, never bytes and never a local path) and the CORE decides admission
// before anything is fetched. `TelegramChannel` performs no `getFile`, no fetch and no local write.

export type { Channel, ChatType, IncomingMessage, OutgoingMessage, AdmittedMessage } from './types';
export { TELEGRAM_CHANNEL_NAME, TelegramChannel, telegramChatType, telegramEventId } from './telegram';
export { TelegramMediaSource } from './telegram-media-source';