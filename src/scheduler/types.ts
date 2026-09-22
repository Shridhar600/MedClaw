export type HeartbeatJobKind = 'routine' | 'medication' | 'recovery' | 'goal';
export type HeartbeatDeliveryState = 'ready' | 'snoozed' | 'retry-wait' | 'dead-letter';
export type SchedulerAuditEventType =
  | 'triggered'
  | 'suppressed'
  | 'sent'
  | 'send_failed'
  | 'noop'
  | 'retry_scheduled'
  | 'retried'
  | 'snoozed'
  | 'acknowledged'
  | 'dead_lettered'
  | 'recovered_missed_run'
  | 'rate_limited';

export type HeartbeatLastOutcome =
  | 'sent'
  | 'noop'
  | 'skipped-quiet-hours'
  | 'skipped-recent-activity'
  | 'error'
  /**
   * RR2-B1 (R2-10/11): the job's destination chat is not owned by the scheduler's profile
   * (or ownership could not be proven). An authorization refusal, not an operational failure:
   * it must never schedule provider retries, increment delivery counts, or claim a send.
   * Maps to the existing `suppressed` audit event semantics.
   */
  | 'skipped-unowned-chat';

export interface HeartbeatJob {
  id: string;
  title: string;
  chatId: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  source: 'system' | 'user' | 'agent';
  kind: HeartbeatJobKind;
  deliveryState: HeartbeatDeliveryState;
  acknowledgedAt?: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: string;
  snoozedUntil?: string;
  lastAttemptAt?: string;
  lastDeliveredAt?: string;
  deadLetterReason?: string;
  policyKey?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastError?: string;
  lastOutcome?: HeartbeatLastOutcome;
  lastOutcomeAt?: string;
}

export interface CreateHeartbeatJobInput {
  title: string;
  chatId: string;
  cron: string;
  timezone?: string;
  prompt: string;
  source: 'system' | 'user' | 'agent';
  kind: HeartbeatJobKind;
  maxRetries?: number;
  policyKey?: string;
}

export interface UpdateHeartbeatJobInput {
  title?: string;
  chatId?: string;
  cron?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
  source?: 'system' | 'user' | 'agent';
  kind?: HeartbeatJobKind;
  deliveryState?: HeartbeatDeliveryState;
  acknowledgedAt?: string;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: string;
  snoozedUntil?: string;
  lastAttemptAt?: string;
  lastDeliveredAt?: string;
  deadLetterReason?: string;
  policyKey?: string;
  lastRunAt?: string;
  lastError?: string;
  lastOutcome?: HeartbeatLastOutcome;
  lastOutcomeAt?: string;
}

export interface SchedulerAuditEvent {
  id: string;
  jobId: string;
  chatId: string;
  type: SchedulerAuditEventType;
  at: string;
  details: Record<string, unknown>;
}

export interface SchedulerAuditEventInput {
  jobId: string;
  chatId: string;
  type: SchedulerAuditEventType;
  at: string;
  details?: Record<string, unknown>;
}

export interface SchedulerAuditLogQuery {
  jobId?: string;
  limit?: number;
}
