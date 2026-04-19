interface HeartbeatRateLimiterOptions {
  maxGlobalTriggersPerMinute: number;
  maxPerChatTriggersPerMinute: number;
}

type RateLimitDecision =
  | { action: 'allow' }
  | { action: 'defer'; scope: 'global' | 'chat'; deferredUntil: string };

interface TriggerHit {
  chatId: string;
  atMs: number;
}

const WINDOW_MS = 60 * 1000;

export class HeartbeatRateLimiter {
  private hits: TriggerHit[] = [];

  constructor(private readonly options: HeartbeatRateLimiterOptions) {}

  consume(chatId: string, now: Date): RateLimitDecision {
    const nowMs = now.getTime();
    this.prune(nowMs);

    if (
      this.options.maxGlobalTriggersPerMinute > 0 &&
      this.hits.length >= this.options.maxGlobalTriggersPerMinute
    ) {
      return {
        action: 'defer',
        scope: 'global',
        deferredUntil: new Date(this.hits[0].atMs + WINDOW_MS).toISOString(),
      };
    }

    const chatHits = this.hits.filter((hit) => hit.chatId === chatId);
    if (
      this.options.maxPerChatTriggersPerMinute > 0 &&
      chatHits.length >= this.options.maxPerChatTriggersPerMinute
    ) {
      return {
        action: 'defer',
        scope: 'chat',
        deferredUntil: new Date(chatHits[0].atMs + WINDOW_MS).toISOString(),
      };
    }

    this.hits.push({ chatId, atMs: nowMs });
    return { action: 'allow' };
  }

  private prune(nowMs: number): void {
    this.hits = this.hits.filter((hit) => (nowMs - hit.atMs) < WINDOW_MS);
  }
}
