
export const CONFIG_SCHEMA_VERSION = 2 as const;

export interface ProviderConfig {
  type: 'ollama' | 'openai' | 'anthropic' | 'google' | 'openrouter';
  baseUrl?: string;
  model: string;
  apiKey?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  allowRawMedicalMedia?: boolean;
  contextWindow?: number;
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

export interface SearchWeights {
  vector: number;
  keyword: number;
}

export interface BudgetRatios {
  health: number;
  life: number;
  agent: number;
}

/** Stored memory settings. `workspace` is derived, never persisted. */
export interface StoredMemoryConfig {
  search: {
    hybridWeights: SearchWeights;
  };
  bootstrapMaxChars: number;
  /** MEMORY.md per-section budget shares; defaults 0.6 / 0.2 / 0.2. */
  budgetRatios?: BudgetRatios;
}

export interface SessionWindowConfig {
  pruneAtPercent: number;
  compactAtPercent: number;
  emergencyAtPercent: number;
  keepRecentTurns: number;
}

export interface SessionsConfig {
  compaction: {
    enabled: boolean;
    memoryFlush: boolean;
    keepRecentTurns: number;
  };
  window?: SessionWindowConfig;
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

/** Stored heartbeat settings. `storePath` and `audit.path` are derived, never persisted. */
export interface StoredHeartbeatConfig {
  enabled: boolean;
  timezone: string;
  policy: HeartbeatPolicyConfig;
  recovery: HeartbeatRecoveryConfig;
  retry: HeartbeatRetryConfig;
  rateLimit: HeartbeatRateLimitConfig;
}

export interface AgentConfig {
  maxIterations: number;
}

export interface EmergencyConfig {
  /** Literal phrases that extend the built-in emergency detector. Built-ins are always kept. */
  keywords: string[];
}

export interface ProfilesConfig {
  baseDir: string;
  defaultProfileId: string;
}

/** The persisted document. Unknown keys, prototype keys and legacy path aliases are refused. */
export interface StoredConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  providers: {
    main: ProviderConfig;
    medical: ProviderConfig;
    embeddings: ProviderConfig;
  };
  channels: ChannelConfig;
  tools: ToolsConfig;
  memory: StoredMemoryConfig;
  sessions: SessionsConfig;
  heartbeat: StoredHeartbeatConfig;
  agent: AgentConfig;
  emergency?: EmergencyConfig;
  profiles: ProfilesConfig;
}

export interface DerivedOwnerPaths {
  workspace: string;
  schedulerStorePath: string;
  auditLogPath: string;
}

export interface EffectiveMemoryConfig extends StoredMemoryConfig {
  /** `<baseDir>/profiles/<ownerId>` — resolved once, injected, never re-derived. */
  workspace: string;
}

export interface EffectiveHeartbeatConfig extends StoredHeartbeatConfig {
  storePath: string;
  audit: { path: string };
}

export interface EffectiveConfig extends Omit<StoredConfig, 'memory' | 'heartbeat'> {
  memory: EffectiveMemoryConfig;
  heartbeat: EffectiveHeartbeatConfig;
}

/** Provider env-var name for a provider type. `ollama` is local and needs no key. */
export type ProviderType = ProviderConfig['type'];
