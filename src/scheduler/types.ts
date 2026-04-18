export type HeartbeatJobKind = 'routine' | 'medication' | 'recovery' | 'goal';

export type HeartbeatLastOutcome =
  | 'sent'
  | 'noop'
  | 'skipped-quiet-hours'
  | 'skipped-recent-activity'
  | 'error';

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
  policyKey?: string;
  lastRunAt?: string;
  lastError?: string;
  lastOutcome?: HeartbeatLastOutcome;
  lastOutcomeAt?: string;
}
