export interface HeartbeatJob {
  id: string;
  title: string;
  chatId: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  source: 'system' | 'user' | 'agent';
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastError?: string;
}

export interface CreateHeartbeatJobInput {
  title: string;
  chatId: string;
  cron: string;
  timezone?: string;
  prompt: string;
  source: 'system' | 'user' | 'agent';
}

export interface UpdateHeartbeatJobInput {
  title?: string;
  cron?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
}
