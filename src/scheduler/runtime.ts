import * as cron from 'node-cron';
import type {
  CreateHeartbeatJobInput,
  HeartbeatJob,
  HeartbeatLastOutcome,
  UpdateHeartbeatJobInput,
} from './types';
import { HeartbeatStore } from './store';

type HeartbeatTrigger = (job: HeartbeatJob) => Promise<void>;

export class HeartbeatScheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();

  constructor(
    private readonly store: HeartbeatStore,
    private readonly trigger: HeartbeatTrigger,
    private readonly defaultTimezone: string = 'Asia/Kolkata',
  ) {}

  async stop(): Promise<void> {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }

  async listJobs(): Promise<HeartbeatJob[]> {
    return this.store.list();
  }

  getStore(): HeartbeatStore {
    return this.store;
  }

  async createJob(input: CreateHeartbeatJobInput): Promise<HeartbeatJob> {
    this.validateCron(input.cron);
    const created = await this.store.create({
      ...input,
      timezone: input.timezone ?? this.defaultTimezone,
    });
    if (created.enabled) {
      this.register(created);
    }
    return created;
  }

  async updateJob(id: string, patch: UpdateHeartbeatJobInput): Promise<HeartbeatJob> {
    const current = await this.store.get(id);
    if (!current) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }

    const nextCron = patch.cron ?? current.cron;
    if ((patch.enabled ?? current.enabled) !== false) {
      this.validateCron(nextCron);
    }

    const updated = await this.store.update(id, patch);
    if (updated.enabled) {
      this.register(updated);
    } else {
      this.unregister(updated.id);
    }
    return updated;
  }

  async deleteJob(id: string): Promise<boolean> {
    this.unregister(id);
    return this.store.remove(id);
  }

  async pause(id: string): Promise<HeartbeatJob> {
    const updated = await this.store.update(id, { enabled: false });
    this.unregister(id);
    return updated;
  }

  async resume(id: string): Promise<HeartbeatJob> {
    const job = await this.store.get(id);
    if (!job) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }
    this.validateCron(job.cron);
    const updated = await this.store.update(id, { enabled: true });
    this.register(updated);
    return updated;
  }

  async runNow(id: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }
    if (!job.enabled) {
      return;
    }
    await this.executeJob(job);
  }

  async recordOutcome(id: string, outcome: HeartbeatLastOutcome): Promise<void> {
    await this.store.markOutcome(id, outcome);
  }

  private register(job: HeartbeatJob): void {
    this.unregister(job.id);
    this.validateCron(job.cron);
    const task = cron.schedule(
      job.cron,
      () => {
        void this.executeJob(job);
      },
      {
        scheduled: true,
        timezone: job.timezone,
      },
    );
    this.tasks.set(job.id, task);
  }

  private unregister(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  private validateCron(expression: string): void {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron: ${expression}`);
    }
  }

  private async executeJob(job: HeartbeatJob): Promise<void> {
    try {
      await this.trigger(job);
      await this.store.markRun(job.id, new Date().toISOString());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.markError(job.id, message);
      console.error(`[scheduler] Heartbeat job failed (${job.id}):`, message);
    }
  }

  private async disableInvalidJob(job: HeartbeatJob, message: string): Promise<void> {
    try {
      await this.store.update(job.id, { enabled: false });
      await this.store.markError(job.id, message);
    } catch (updateError) {
      console.error(`[scheduler] Failed to disable invalid heartbeat job (${job.id}):`, updateError);
    }
  }

  async start(): Promise<void> {
    const jobs = await this.store.list();
    for (const job of jobs) {
      if (!job.enabled) {
        continue;
      }
      try {
        this.register(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.disableInvalidJob(job, message);
        console.error(`[scheduler] Failed to register heartbeat job (${job.id}):`, message);
      }
    }
  }
}
