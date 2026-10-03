/**
 * Which channel this arrived on, and whether it was a one-to-one chat.
 *
 * S1 requires all three for admission: a text message with no transport identity is refused
 * rather than treated as coming from somewhere known. They are optional on the wire type only so
 * the pre-S1 direct-Router tests still describe a message shape; the admission path treats an
 * absent value as missing identity.
 */
import type { MediaReference } from '../ports/media-source';

export type { MediaReference };

export type ChatType = 'private' | 'group' | 'supergroup' | 'channel' | 'local';

export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  /** Source channel name, e.g. `telegram`. */
  channel?: string;
  /** Whether this was a private chat. Group traffic never gains health state. */
  chatType?: ChatType;
  /**
   * Stable identity for this exact transport event (`telegram:<chatId>:<messageId>`), so a
   * redelivery cannot spend a second pairing attempt.
   */
  eventId?: string;
  /** Source message identity, when the channel provides one, for capture deduplication. */
  messageId?: string;
  /**
   * An OPAQUE handle to attached media. The transport emits this and nothing else: it has not
   * fetched the bytes, resolved a URL or written a file. Retrieval happens only after the core has
   * admitted the sender.
   */
  media?: MediaReference;
  replyToMessageId?: string;
}

/**
 * The internal shape the core works with, after admission has staged any media.
 *
 * `mediaPath` is deliberately NOT part of the wire type. A transport must never be able to assert a
 * path; only the core's own stager may, and only after admission. Keeping the two types apart makes
 * "a transport supplied a local path" unrepresentable rather than merely discouraged.
 */
export interface AdmittedMessage extends IncomingMessage {
  /** Absolute staging path, set by the core's stager. Adopted into the workspace by the Router. */
  mediaPath?: string;
  mediaError?: string;
}

export interface OutgoingMessage {
  text: string;
  replyToMessageId?: string;
  parseMode?: 'Markdown' | 'HTML';
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  send(chatId: string, message: OutgoingMessage): Promise<void>;
  disconnect(): Promise<void>;
}
