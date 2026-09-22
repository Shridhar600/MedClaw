export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  /** Source message identity, when the channel provides one, for capture deduplication. */
  messageId?: string;
  /** Absolute profile-agnostic staging path until the gateway Router adopts it into a profile workspace. */
  mediaPath?: string;
  mediaError?: string;
  replyToMessageId?: string;
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
