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
  /**
   * RR2-B1 (R2-10/11): destination-ownership capability, closed over the OWNING profile's
   * identity. Optional so standalone/non-profile scheduler use keeps this module's
   * path-agnostic interface; every actual daemon ProfileRuntime supplies it (a
   * `canSchedule:true` factory path without one refuses scheduler activation — see
   * `ProfileRuntime.create`). When present it gates createJob/updateJob/resume/start
   * registration so a foreign-addressed record can never be created, re-pointed, or
   * re-enabled unnoticed; `job.chatId` is a destination, never authority.
   */
  canAddressChat?: (chatId: string) => boolean;
}

export class HeartbeatScheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private wakeupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly inFlight: Map<string, Promise<void>> = new Map();
  private readonly transitionChains: Map<string, Promise<void>> = new Map();
  private readonly auditLog?: SchedulerAuditLog;
  private readonly defaultMaxRetries: number;
  private readonly rateLimiter: HeartbeatRateLimiter;
  private readonly now: () => Date;
  private readonly recoveryEnabled: boolean;
  private readonly recoveryWindowMinutes: number;
  private readonly retryBackoffMinutes: number;
  private readonly canAddressChat?: (chatId: string) => boolean;
  private stopping = false;

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
    this.canAddressChat = options.canAddressChat;
  }

  /**
   * RR2-B1: is `chatId` an addressable destination for THIS profile's scheduler? Absent guard
   * (standalone/non-profile use) keeps the legacy unguarded behavior. A throwing lookup is a
   * refusal, never an authorization.
   */
  private isDestinationAddressable(chatId: string): boolean {
    if (!this.canAddressChat) return true;
    try {
      return this.canAddressChat(chatId) === true;
    } catch (error) {
      console.warn('[scheduler] Destination ownership lookup failed; refusing:', summarizeErrorForLog(error));
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const task of this.tasks.values()) {
      task.stop();
    }
    for (const timer of this.wakeupTimers.values()) {
      clearTimeout(timer);
    }
    this.tasks.clear();
    this.wakeupTimers.clear();
    // No new launch can pass the stopping gate. Existing jobs are awaited without a
    // time cap so callers never close their stores while a heartbeat still writes.
    await this.drainInFlight();
  }

  private async drainInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
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
    if (this.stopping) throw new Error('heartbeat scheduler is stopped');
    this.validateCron(input.cron);
    // RR2-B1: refuse to persist a destination this profile does not own (cron_manage's
    // optional chatId stays; same-profile alternates pass, foreign/unpaired refuse).
    if (!this.isDestinationAddressable(input.chatId)) {
      throw new Error('Refusing to create a heartbeat job for a chat this profile does not own.');
    }
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
    if (this.stopping) throw new Error('heartbeat scheduler is stopped');
    const current = await this.store.get(id);
    if (!current) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }

    const nextCron = patch.cron ?? current.cron;
    if ((patch.enabled ?? current.enabled) !== false) {
      this.validateCron(nextCron);
    }

    // RR2-B1: refuse both re-pointing a job at a foreign chat and re-enabling a
    // foreign-addressed record — either would re-arm work against another profile.
    const nextChatId = patch.chatId ?? current.chatId;
    const willBeEnabled = (patch.enabled ?? current.enabled) !== false;
    if (willBeEnabled && !this.isDestinationAddressable(nextChatId)) {
      throw new Error('Refusing to keep a heartbeat job pointed at a chat this profile does not own.');
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
    if (this.stopping) return false;
    this.unregister(id);
    return this.store.remove(id);
  }

  async pause(id: string): Promise<HeartbeatJob> {
    if (this.stopping) throw new Error('heartbeat scheduler is stopped');
    const updated = await this.store.update(id, { enabled: false });
    this.unregister(id);
    return updated;
  }

  async resume(id: string): Promise<HeartbeatJob> {
    if (this.stopping) throw new Error('heartbeat scheduler is stopped');
    const job = await this.store.get(id);
    if (!job) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }
    // RR2-B1: a persisted foreign-addressed record cannot be re-enabled unnoticed.
    if (!this.isDestinationAddressable(job.chatId)) {
      throw new Error('Refusing to resume a heartbeat job addressed to a chat this profile does not own.');
    }
    this.validateCron(job.cron);
    const updated = await this.store.update(id, { enabled: true });
    this.register(updated);
    this.scheduleStateWakeup(updated);
    return updated;
  }

  async runNow(id: string): Promise<void> {
    if (this.stopping) return;
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
    await this.withJobTransition(id, async () => {
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
    });
  }

  async recordFailure(id: string, message: string): Promise<HeartbeatJob> {
    return this.withJobTransition(id, async () => {
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
    });
  }

  private register(job: HeartbeatJob): void {
    if (this.stopping) return;
    this.unregister(job.id);
    this.validateCron(job.cron);
    const task = cron.schedule(
      job.cron,
      () => {
        this.launchDetached(job);
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
    if (this.stopping) return;
    if (this.inFlight.has(job.id)) {
      console.log(`[scheduler] Skipping tick for ${job.id}: previous run still in flight`);
      return;
    }
    const run = this.executeJobBody(job);
    this.inFlight.set(job.id, run);
    try {
      await run;
    } finally {
      if (this.inFlight.get(job.id) === run) this.inFlight.delete(job.id);
    }
  }

  private async executeJobBody(job: HeartbeatJob): Promise<void> {
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

      await this.trigger(current);
      await this.store.markRun(current.id, now.toISOString());
    } catch (error) {
      await this.recordExecutionFailure(job.id, error);
    }
  }

  private async recordExecutionFailure(id: string, error: unknown): Promise<void> {
    const message = summarizeErrorForLog(error);
    console.error(`[scheduler] Heartbeat job failed (${id}):`, message);
    try {
      await this.recordFailure(id, message);
    } catch (recordError) {
      console.error(
        `[scheduler] Failed to record heartbeat failure (${id}):`,
        summarizeErrorForLog(recordError),
      );
    }
  }

  private launchDetached(job: HeartbeatJob): void {
    // Keep the catch at the detached boundary even though executeJob has its own
    // state-machine guard. This protects future changes from bare void rejections.
    void this.executeJob(job).catch((error) => {
      void this.recordExecutionFailure(job.id, error);
    });
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
    this.stopping = false;
    const jobs = await this.store.list();
    for (const job of jobs) {
      if (!job.enabled) {
        continue;
      }
      // RR2-B1: a persisted foreign-addressed record must not silently come back live at
      // boot — disable + markError (same A1 boundary treatment as invalid-cron records).
      if (!this.isDestinationAddressable(job.chatId)) {
        const refusalMessage = 'heartbeat job destination is not owned by this profile';
        await this.disableInvalidJob(job, refusalMessage);
        console.error(`[scheduler] Refused to register heartbeat job (${job.id}): ${refusalMessage}`);
        continue;
      }
      try {
        this.register(job);
        this.scheduleStateWakeup(job);
      } catch (error) {
        const message = summarizeErrorForLog(error);
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
    if (this.stopping) return;
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
      this.launchDetached(job);
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

  private withJobTransition<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionChains.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.transitionChains.set(id, chain);

    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (this.transitionChains.get(id) === chain) this.transitionChains.delete(id);
      }
    })();
  }
}
