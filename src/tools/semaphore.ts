// Priority order (highest first): user > heartbeat > background. `background` (F8) is for work that
// must never starve or collide with user turns — compaction LLM calls, future P4/P5 writers — and
// deliberately sits below heartbeat so it does not consume heartbeat queue slots (v2-H-4).
export type SemaphorePriority = 'user' | 'heartbeat' | 'background';

/** Typed overload sentinel. Callers must branch on the type, not the message. */
export class SemaphoreQueueFullError extends Error {
  constructor(readonly priority: SemaphorePriority) {
    super(`${priority} queue full`);
    this.name = 'SemaphoreQueueFullError';
  }
}

export class HeartbeatQueueFullError extends SemaphoreQueueFullError {
  constructor() {
    super('heartbeat');
    this.name = 'HeartbeatQueueFullError';
  }
}

export class UserQueueFullError extends SemaphoreQueueFullError {
  constructor() {
    super('user');
    this.name = 'UserQueueFullError';
  }
}

export class BackgroundQueueFullError extends SemaphoreQueueFullError {
  constructor() {
    super('background');
    this.name = 'BackgroundQueueFullError';
  }
}

export class SemaphoreShutdownError extends Error {
  /** Matches the non-retryable client-cancel class used by the compaction retry guard. */
  readonly status = 499;

  constructor() {
    super('LLM semaphore is shut down');
    this.name = 'SemaphoreShutdownError';
  }
}

interface QueueEntry {
  fn: () => Promise<void>;
  reject: (reason: unknown) => void;
}

export interface LLMSemaphoreOptions {
  maxQueuedUsers?: number;
  maxQueuedHeartbeats?: number;
  maxQueuedBackground?: number;
  /** Run one waiting background job after this many consecutive user jobs. */
  maxConsecutiveUserJobsWithBackground?: number;
}

const DEFAULT_MAX_QUEUED_USERS = 100;
const DEFAULT_MAX_QUEUED_HEARTBEATS = 10;
const DEFAULT_MAX_QUEUED_BACKGROUND = 20;
const DEFAULT_MAX_CONSECUTIVE_USER_JOBS_WITH_BACKGROUND = 8;

export class LLMSemaphore {
  private running = false;
  private userQueue: QueueEntry[] = [];
  private heartbeatQueue: QueueEntry[] = [];
  private backgroundQueue: QueueEntry[] = [];
  private consecutivePriorityJobs = 0;
  private closed = false;

  private readonly maxQueuedUsers: number;
  private readonly maxQueuedHeartbeats: number;
  private readonly maxQueuedBackground: number;
  private readonly maxConsecutiveUserJobsWithBackground: number;

  constructor(options: LLMSemaphoreOptions = {}) {
    this.maxQueuedUsers = options.maxQueuedUsers ?? DEFAULT_MAX_QUEUED_USERS;
    this.maxQueuedHeartbeats = options.maxQueuedHeartbeats ?? DEFAULT_MAX_QUEUED_HEARTBEATS;
    this.maxQueuedBackground = options.maxQueuedBackground ?? DEFAULT_MAX_QUEUED_BACKGROUND;
    this.maxConsecutiveUserJobsWithBackground = options.maxConsecutiveUserJobsWithBackground
      ?? DEFAULT_MAX_CONSECUTIVE_USER_JOBS_WITH_BACKGROUND;
  }

  async run<T>(priority: SemaphorePriority, fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new SemaphoreShutdownError());
    }

    const queue = this.queueFor(priority);
    const limit = this.limitFor(priority);
    if (queue.length >= limit) {
      return Promise.reject(this.queueFullErrorFor(priority));
    }

    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new SemaphoreShutdownError());
        return;
      }
      const entry: QueueEntry = {
        fn: async () => {
          try {
            resolve(await fn());
          } catch (error) {
            reject(error);
          }
        },
        reject,
      };
      queue.push(entry);
      void this.drain();
    });
  }

  /** Reject pending work and refuse future enqueues. The active call is not interrupted. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new SemaphoreShutdownError();
    for (const queue of [this.userQueue, this.heartbeatQueue, this.backgroundQueue]) {
      for (const entry of queue) entry.reject(error);
      queue.length = 0;
    }
  }

  private hasWork(): boolean {
    return this.userQueue.length > 0 || this.heartbeatQueue.length > 0 || this.backgroundQueue.length > 0;
  }

  private queueFor(priority: SemaphorePriority): QueueEntry[] {
    if (priority === 'user') return this.userQueue;
    if (priority === 'heartbeat') return this.heartbeatQueue;
    return this.backgroundQueue;
  }

  private limitFor(priority: SemaphorePriority): number {
    if (priority === 'user') return this.maxQueuedUsers;
    if (priority === 'heartbeat') return this.maxQueuedHeartbeats;
    return this.maxQueuedBackground;
  }

  private queueFullErrorFor(priority: SemaphorePriority): SemaphoreQueueFullError {
    if (priority === 'user') return new UserQueueFullError();
    if (priority === 'heartbeat') return new HeartbeatQueueFullError();
    return new BackgroundQueueFullError();
  }

  private nextJob(): QueueEntry {
    // User remains ahead of heartbeat. A waiting background job receives one reserved turn after a
    // bounded user burst, so a continuous stream of users cannot starve background maintenance forever.
    if (this.userQueue.length > 0) {
      if (this.backgroundQueue.length > 0
        && this.consecutivePriorityJobs >= this.maxConsecutiveUserJobsWithBackground) {
        this.consecutivePriorityJobs = 0;
        return this.backgroundQueue.shift()!;
      }
      this.consecutivePriorityJobs += 1;
      return this.userQueue.shift()!;
    }
    if (this.heartbeatQueue.length > 0) {
      if (this.backgroundQueue.length > 0
        && this.consecutivePriorityJobs >= this.maxConsecutiveUserJobsWithBackground) {
        this.consecutivePriorityJobs = 0;
        return this.backgroundQueue.shift()!;
      }
      this.consecutivePriorityJobs += 1;
      return this.heartbeatQueue.shift()!;
    }
    this.consecutivePriorityJobs = 0;
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
      if (!this.closed && this.hasWork()) {
        void this.drain();
      }
    }
  }
}
