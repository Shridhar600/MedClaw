# channels

**Purpose:** The transport edge. A channel turns a transport's inbound payload into a normalized
`IncomingMessage`, and sends an `OutgoingMessage` back out. It is the only place that knows a transport
exists at all.

**Public API (`index.ts` — the only import surface):**
- `IncomingMessage` / `AdmittedMessage` / `OutgoingMessage` / `Channel` / `ChatType` — the normalized
  shapes. A channel MUST NOT leak transport-specific fields into them.
- `TelegramChannel`, `TELEGRAM_CHANNEL_NAME`, `telegramEventId`, `telegramChatType`.
- `TelegramMediaSource` — the `MediaSourcePort` adapter for Telegram file downloads.
- `TelegramFileApi` / `TelegramFileFetcher` / `TelegramMediaSourceOptions` — injected transport IO.

**Dependencies:** `../security` (for `summarizeErrorForLog`), `grammy`, `../ports`. No core module, no
`gateway/`, no `memory/`, no filesystem policy.

## The rule this module exists to enforce

A channel does **no work on an unauthenticated sender's behalf.** Concretely:

- **No `getFile`, no fetch, no local write, no buffering.** `TelegramChannel` hands over an opaque
  `MediaReference` — a channel name, a transport file id, a kind, and presentation metadata — and stops.
  The bytes are fetched only after the core admits the sender, by an injected `MediaSourcePort`.
- **No policy.** Admission, pairing, health wording and owner authority are core decisions. A transport
  that made them would let a stranger's message decide who may read the owner's health data.
- **No path construction from transport data.** `displayName` is presentation metadata and is never
  trusted as a path component; the staging layer generates its own names.

This split is a safety boundary, not a style choice. A media message must cause no work before the core
has established who is asking.

`MediaReference` deliberately carries **no local path and no fetchable URL**: a path would be authority,
and a URL in the core would be a request the core issued on a stranger's say-so.

## Transport identity

Retrieval connects caller cancellation and its one standalone timer before metadata lookup. The same
signal reaches getFile, fetch and reader consumption. Core's queue-inclusive deadline remains the intake
limit. Pre-aborted or late metadata starts no body request; a late response is cancelled without a reader.
Reader cancellation refuses partial bytes instead of treating cancellation as successful EOF. Completion
and cancellation dispose owned timers/listeners/readers. Uncooperative external promises remain observed;
an abort request does not guarantee external acknowledgement or force those promises to settle.

`telegramEventId` and `telegramChatType` normalize transport identity so the core sees one shape.
`eventId` must be stable across redelivery (`telegram:<chatId>:<messageId>`) so a redelivered pairing
message cannot spend a second attempt — the admission state machine keys its rate limit on it.

## Extraction notes

Copy `src/channels/` plus `src/ports/` and `src/security`'s `summarizeErrorForLog` into an empty project.
A new transport (WhatsApp, Matrix, a local CLI) is **one new file implementing `Channel`**, plus a
`MediaSourcePort` adapter if it carries media — and zero changes to this module's other files or to the
core. That is the swap guarantee: transport variety is additive, not invasive.
