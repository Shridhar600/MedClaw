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
  eventId?: string;
  /** Source message identity, when the channel provides one, for capture deduplication. */
  messageId?: string;
  media?: MediaReference;
  replyToMessageId?: string;
}

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
