export type SemaphorePriority = 'user' | 'heartbeat';

interface QueueEntry {
  fn: () => Promise<void>;
}

const MAX_QUEUED_HEARTBEATS = 10;

export class LLMSemaphore {
  private running = false;
  private userQueue: QueueEntry[] = [];
  private heartbeatQueue: QueueEntry[] = [];

  async run<T>(priority: SemaphorePriority, fn: () => Promise<T>): Promise<T> {
    if (priority === 'heartbeat' && this.heartbeatQueue.length >= MAX_QUEUED_HEARTBEATS) {
      return Promise.reject(new Error('heartbeat queue full'));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = { fn: () => fn().then(resolve, reject) };
      if (priority === 'user') {
        this.userQueue.push(entry);
      } else {
        this.heartbeatQueue.push(entry);
      }
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // User priority is absolute: drain the user queue fully before
      // touching any queued heartbeat work.
      while (this.userQueue.length > 0 || this.heartbeatQueue.length > 0) {
        const job = this.userQueue.length > 0 ? this.userQueue.shift()! : this.heartbeatQueue.shift()!;
        try {
          await job.fn();
        } catch {
          // Individual job error must not deadlock the queue
        }
      }
    } finally {
      this.running = false;
      // If more jobs were added during the finally block, restart drain
      if (this.userQueue.length > 0 || this.heartbeatQueue.length > 0) {
        void this.drain();
      }
    }
  }
}
