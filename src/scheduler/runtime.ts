import * as cron from 'node-cron';
import type {
  CreateHeartbeatJobInput,
  HeartbeatJob,
  HeartbeatLastOutcome,
  SchedulerAuditEvent,
  SchedulerAuditEventType,
  UpdateHeartbeatJobInput,
} from './types';
import { SchedulerAuditLog } from './audit-log';
import { HeartbeatRateLimiter } from './rate-limit';
import { findMostRecentMissedRun } from './recovery';
import { determineRetryAction } from './retry-policy';
import { HeartbeatStore } from './store';
import { summarizeErrorForLog } from '../security';

type HeartbeatTrigger = (job: HeartbeatJob) => Promise<void>;

interface HeartbeatSchedulerOptions {
  auditLogPath?: string;
  defaultMaxRetries?: number;
  maxGlobalTriggersPerMinute?: number;
  maxPerChatTriggersPerMinute?: number;
  now?: () => Date;
  recoveryEnabled?: boolean;
  recoveryWindowMinutes?: number;
  retryBackoffMinutes?: number;
}

export class HeartbeatScheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private wakeupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly inFlight: Set<string> = new Set();
  private readonly auditLog?: SchedulerAuditLog;
  private readonly defaultMaxRetries: number;
  private readonly rateLimiter: HeartbeatRateLimiter;
  private readonly now: () => Date;
  private readonly recoveryEnabled: boolean;
  private readonly recoveryWindowMinutes: number;
  private readonly retryBackoffMinutes: number;

  constructor(
    private readonly store: HeartbeatStore,
    private readonly trigger: HeartbeatTrigger,
    private readonly defaultTimezone: string = 'Asia/Kolkata',
    options: HeartbeatSchedulerOptions = {},
  ) {
    this.auditLog = options.auditLogPath ? new SchedulerAuditLog(options.auditLogPath) : undefined;
    this.defaultMaxRetries = options.defaultMaxRetries ?? 0;
    this.rateLimiter = new HeartbeatRateLimiter({
      maxGlobalTriggersPerMinute: options.maxGlobalTriggersPerMinute ?? 0,
      maxPerChatTriggersPerMinute: options.maxPerChatTriggersPerMinute ?? 0,
    });
    this.now = options.now ?? (() => new Date());
    this.recoveryEnabled = options.recoveryEnabled ?? false;
    this.recoveryWindowMinutes = options.recoveryWindowMinutes ?? 60;
    this.retryBackoffMinutes = options.retryBackoffMinutes ?? 5;
  }

  async stop(): Promise<void> {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    for (const timer of this.wakeupTimers.values()) {
      clearTimeout(timer);
    }
    this.tasks.clear();
    this.wakeupTimers.clear();
    // RES-P2-3: no new cron ticks can fire (tasks stopped), but a job already
    // executing executeJob must be allowed to finish before stop() resolves so
    // callers (e.g. gateway.stop on SIGTERM) do not tear down the process
    // while a heartbeat trigger is mid-flight. Bounded wait so a stuck job
    // never blocks shutdown forever.
    await this.drainInFlight(10_000);
  }

  private async drainInFlight(capMs = 10_000): Promise<void> {
    const pollMs = 50;
    const deadline = Date.now() + capMs;
    while (this.inFlight.size > 0) {
      if (Date.now() >= deadline) {
        console.warn(
          `[scheduler] stop() waited ${capMs}ms for inFlight jobs; ${this.inFlight.size} still running, giving up.`,
        );
        return;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        // Never keep the event loop alive solely for the drain poll.
        t.unref?.();
      });
    }
  }

  async listJobs(): Promise<HeartbeatJob[]> {
    return this.store.list();
  }

  async readAuditEvents(jobId?: string, limit: number = 5): Promise<SchedulerAuditEvent[]> {
    if (!this.auditLog) {
      return [];
    }
    return this.auditLog.readRecent({ jobId, limit });
  }

  getStore(): HeartbeatStore {
    return this.store;
  }

  async createJob(input: CreateHeartbeatJobInput): Promise<HeartbeatJob> {
    this.validateCron(input.cron);
    const created = await this.store.create({
      ...input,
      timezone: input.timezone ?? this.defaultTimezone,
      maxRetries: input.maxRetries ?? this.defaultMaxRetries,
    });
    if (created.enabled) {
      this.register(created);
    }
    this.scheduleStateWakeup(created);
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
    this.scheduleStateWakeup(updated);
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
    this.scheduleStateWakeup(updated);
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
    const job = await this.store.get(id);
    if (!job) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }
    const now = this.now().toISOString();
    const updated = await this.store.update(id, {
      lastOutcome: outcome,
      lastOutcomeAt: now,
      lastError: outcome === 'error' ? job.lastError : undefined,
      deliveryState: outcome === 'error' ? job.deliveryState : 'ready',
      nextRetryAt: outcome === 'error' ? job.nextRetryAt : undefined,
      deadLetterReason: outcome === 'error' ? job.deadLetterReason : undefined,
      lastAttemptAt: now,
      lastDeliveredAt: outcome === 'sent' ? now : job.lastDeliveredAt,
    });
    this.scheduleStateWakeup(updated);
    await this.appendAudit(job, this.toAuditEventType(outcome), { outcome });
  }

  async recordFailure(id: string, message: string): Promise<HeartbeatJob> {
    const job = await this.store.get(id);
    if (!job) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }

    const failedAt = this.now().toISOString();
    const decision = determineRetryAction(
      job,
      {
        outcome: 'error',
        failedAt,
        errorMessage: message,
      },
      { backoffMinutes: this.retryBackoffMinutes },
    );

    if (decision.action === 'none') {
      await this.store.markError(id, message);
      this.clearStateWakeup(id);
      await this.appendAudit(job, 'send_failed', { error: message, action: 'none' });
      return (await this.store.get(id))!;
    }

    const updated = await this.store.update(id, decision.patch);
    this.scheduleStateWakeup(updated);
    await this.appendAudit(updated, 'send_failed', { error: message });
    await this.appendAudit(
      updated,
      decision.action === 'retry' ? 'retry_scheduled' : 'dead_lettered',
      decision.action === 'retry'
        ? { nextRetryAt: updated.nextRetryAt, retryCount: updated.retryCount }
        : { retryCount: updated.retryCount, reason: updated.deadLetterReason },
    );
    return updated;
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
    this.clearStateWakeup(id);
  }

  private validateCron(expression: string): void {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron: ${expression}`);
    }
  }

  private async executeJob(job: HeartbeatJob): Promise<void> {
    if (this.inFlight.has(job.id)) {
      console.log(`[scheduler] Skipping tick for ${job.id}: previous run still in flight`);
      return;
    }
    this.inFlight.add(job.id);
    try {
      let current = await this.store.get(job.id);
      if (!current || !current.enabled) {
        return;
      }

      const now = this.now();
      if (current.deliveryState === 'dead-letter') {
        return;
      }

      if (current.deliveryState === 'snoozed') {
        if (!current.snoozedUntil || new Date(current.snoozedUntil).getTime() > now.getTime()) {
          this.scheduleStateWakeup(current);
          return;
        }
        current = await this.store.update(current.id, {
          deliveryState: 'ready',
          snoozedUntil: undefined,
        });
      }

      if (current.deliveryState === 'retry-wait') {
        if (!current.nextRetryAt || new Date(current.nextRetryAt).getTime() > now.getTime()) {
          this.scheduleStateWakeup(current);
          return;
        }
        current = await this.store.update(current.id, {
          deliveryState: 'ready',
          nextRetryAt: undefined,
        });
        await this.appendAudit(current, 'retried', { retryCount: current.retryCount });
      }

      const decision = this.rateLimiter.consume(current.chatId, now);
      if (decision.action === 'defer') {
        const deferred = await this.store.update(current.id, {
          deliveryState: 'retry-wait',
          nextRetryAt: decision.deferredUntil,
        });
        this.scheduleStateWakeup(deferred);
        await this.appendAudit(current, 'rate_limited', {
          scope: decision.scope,
          deferredUntil: decision.deferredUntil,
        });
        return;
      }

      try {
        await this.trigger(current);
        await this.store.markRun(current.id, now.toISOString());
      } catch (error) {
        // lastError is persisted and this line hits the console — sanitize;
        // provider/agent errors can echo PHI in their messages.
        const message = summarizeErrorForLog(error);
        console.error(`[scheduler] Heartbeat job failed (${current.id}):`, message);
        try {
          await this.recordFailure(current.id, message);
        } catch (recordError) {
          // executeJob is invoked fire-and-forget from cron ticks; a storage
          // failure here must not become an unhandled rejection.
          console.error(
            `[scheduler] Failed to record heartbeat failure (${current.id}):`,
            summarizeErrorForLog(recordError),
          );
        }
      }
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  private async disableInvalidJob(job: HeartbeatJob, message: string): Promise<void> {
    try {
      await this.store.update(job.id, { enabled: false });
      await this.store.markError(job.id, message);
    } catch (updateError) {
      // Storage update error — raw object could echo PHI context; sanitized frame only.
      console.error(`[scheduler] Failed to disable invalid heartbeat job (${job.id}):`, summarizeErrorForLog(updateError));
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
        this.scheduleStateWakeup(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.disableInvalidJob(job, message);
        console.error(`[scheduler] Failed to register heartbeat job (${job.id}):`, message);
      }
    }
    if (this.recoveryEnabled) {
      await this.recoverMissedRuns();
    }
  }

  private async appendAudit(
    job: HeartbeatJob,
    type: SchedulerAuditEventType,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditLog) {
      return;
    }
    await this.auditLog.append({
      jobId: job.id,
      chatId: job.chatId,
      type,
      at: new Date().toISOString(),
      details,
    });
  }

  private toAuditEventType(outcome: HeartbeatLastOutcome): SchedulerAuditEventType {
    if (outcome === 'sent') {
      return 'sent';
    }
    if (outcome === 'noop') {
      return 'noop';
    }
    if (outcome === 'error') {
      return 'send_failed';
    }
    return 'suppressed';
  }

  private async recoverMissedRuns(): Promise<void> {
    const jobs = await this.store.list();
    const now = this.now();
    for (const job of jobs) {
      const scheduledFor = findMostRecentMissedRun(job, {
        now,
        windowMinutes: this.recoveryWindowMinutes,
      });
      if (!scheduledFor) {
        continue;
      }
      await this.appendAudit(job, 'recovered_missed_run', { scheduledFor });
      await this.executeJob(job);
    }
  }

  private scheduleStateWakeup(job: HeartbeatJob): void {
    this.clearStateWakeup(job.id);
    if (!job.enabled || job.deliveryState === 'dead-letter') {
      return;
    }

    const dueAt = this.getStateWakeupAt(job);
    if (!dueAt) {
      return;
    }

    const delayMs = Math.max(0, dueAt.getTime() - this.now().getTime());
    const timer = setTimeout(() => {
      this.wakeupTimers.delete(job.id);
      void this.executeJob(job);
    }, delayMs);
    timer.unref?.();
    this.wakeupTimers.set(job.id, timer);
  }

  private clearStateWakeup(id: string): void {
    const timer = this.wakeupTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.wakeupTimers.delete(id);
    }
  }

  private getStateWakeupAt(job: HeartbeatJob): Date | undefined {
    if (job.deliveryState === 'retry-wait' && job.nextRetryAt) {
      return new Date(job.nextRetryAt);
    }
    if (job.deliveryState === 'snoozed' && job.snoozedUntil) {
      return new Date(job.snoozedUntil);
    }
    return undefined;
  }
}
