// Priority order (highest first): user > heartbeat > background. `background` (F8) is for work that
// must never starve or collide with user turns — compaction LLM calls, future P4/P5 writers — and
// deliberately sits below heartbeat so it does not consume heartbeat queue slots (v2-H-4).
export type SemaphorePriority = 'user' | 'heartbeat' | 'background';

// Typed sentinel so callers (gateway queue-full handling) can instanceof-check
// instead of matching the message string, which breaks silently under wrapping.
export class HeartbeatQueueFullError extends Error {
  constructor() {
    super('heartbeat queue full');
    this.name = 'HeartbeatQueueFullError';
  }
}

interface QueueEntry {
  fn: () => Promise<void>;
}

const MAX_QUEUED_HEARTBEATS = 10;

export class LLMSemaphore {
  private running = false;
  private userQueue: QueueEntry[] = [];
  private heartbeatQueue: QueueEntry[] = [];
  private backgroundQueue: QueueEntry[] = [];

  async run<T>(priority: SemaphorePriority, fn: () => Promise<T>): Promise<T> {
    if (priority === 'heartbeat' && this.heartbeatQueue.length >= MAX_QUEUED_HEARTBEATS) {
      return Promise.reject(new HeartbeatQueueFullError());
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = { fn: () => fn().then(resolve, reject) };
      if (priority === 'user') {
        this.userQueue.push(entry);
      } else if (priority === 'heartbeat') {
        this.heartbeatQueue.push(entry);
      } else {
        this.backgroundQueue.push(entry);
      }
      void this.drain();
    });
  }

  private hasWork(): boolean {
    return this.userQueue.length > 0 || this.heartbeatQueue.length > 0 || this.backgroundQueue.length > 0;
  }

  private nextJob(): QueueEntry {
    // Strict priority: user > heartbeat > background. User priority is absolute; background work
    // (compaction, background writers) only runs when nothing higher is queued (F8).
    if (this.userQueue.length > 0) return this.userQueue.shift()!;
    if (this.heartbeatQueue.length > 0) return this.heartbeatQueue.shift()!;
    return this.backgroundQueue.shift()!;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.hasWork()) {
        const job = this.nextJob();
        try {
          await job.fn();
        } catch {
          // Individual job error must not deadlock the queue
        }
      }
    } finally {
      this.running = false;
      // If more jobs were added during the finally block, restart drain
      if (this.hasWork()) {
        void this.drain();
      }
    }
  }
}
