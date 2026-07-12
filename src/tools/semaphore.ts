export type SemaphorePriority = 'user' | 'heartbeat';

interface QueueEntry {
  priority: number;
  fn: () => Promise<void>;
}

export class LLMSemaphore {
  private running = false;
  private queue: QueueEntry[] = [];

  async run<T>(priority: SemaphorePriority, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority: priority === 'user' ? 0 : 1,
        fn: () => fn().then(resolve, reject),
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        this.queue.sort((a, b) => a.priority - b.priority);
        const job = this.queue.shift()!;
        try {
          await job.fn();
        } catch {
          // Individual job error must not deadlock the queue
        }
      }
    } finally {
      this.running = false;
      // If more jobs were added during the finally block, restart drain
      if (this.queue.length > 0) {
        void this.drain();
      }
    }
  }
}
