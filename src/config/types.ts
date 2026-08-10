// src/config/types.ts

export interface ProviderConfig {
  type: 'ollama' | 'openai' | 'anthropic' | 'google';
  baseUrl?: string;
  model: string;
  apiKey?: string;
  allowRawMedicalMedia?: boolean;
}

export interface ChannelConfig {
  telegram: {
    enabled: boolean;
    botToken: string;
  };
}

export interface ToolsConfig {
  allow: string[];
  deny: string[];
}

export interface MemoryConfig {
  workspace: string;
  search: {
    hybridWeights: { vector: number; keyword: number };
  };
  bootstrapMaxChars: number;
}

export interface SessionsConfig {
  softResetAfterMinutes: number;
  hardResetAfterMinutes: number;
  compaction: {
    enabled: boolean;
    triggerAtTokenPercent: number;
    memoryFlush: boolean;
    keepRecentTurns: number;
  };
}

export interface HeartbeatPolicyConfig {
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
  skipIfChatActiveWithinMinutes: number;
  defaults: {
    morningCheckIn: {
      enabled: boolean;
      cron: string;
      prompt: string;
    };
    eveningSummary: {
      enabled: boolean;
      cron: string;
      prompt: string;
    };
  };
}

export interface HeartbeatRecoveryConfig {
  enabled: boolean;
  windowMinutes: number;
}

export interface HeartbeatRetryConfig {
  maxRetries: number;
  backoffMinutes: number;
}

export interface HeartbeatRateLimitConfig {
  maxGlobalTriggersPerMinute: number;
  maxPerChatTriggersPerMinute: number;
}

export interface HeartbeatAuditConfig {
  path: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  timezone: string;
  storePath: string;
  policy: HeartbeatPolicyConfig;
  recovery: HeartbeatRecoveryConfig;
  retry: HeartbeatRetryConfig;
  rateLimit: HeartbeatRateLimitConfig;
  audit: HeartbeatAuditConfig;
}

export interface AgentConfig {
  maxIterations: number;
  disclaimerEnabled: boolean;
}

export interface ProfileConfig {
  baseDir: string;
  defaultProfileId: string;
}

export interface AppConfig {
  providers: {
    main: ProviderConfig;
    medical: ProviderConfig;
    embeddings: ProviderConfig;
  };
  channels: ChannelConfig;
  tools: ToolsConfig;
  memory: MemoryConfig;
  sessions: SessionsConfig;
  heartbeat: HeartbeatConfig;
  agent: AgentConfig;
  profiles?: ProfileConfig;
}
