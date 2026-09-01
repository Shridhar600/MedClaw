// src/config/types.ts

export interface ProviderConfig {
  type: 'ollama' | 'openai' | 'anthropic' | 'google' | 'openrouter';
  baseUrl?: string;
  model: string;
  apiKey?: string;
  /**
   * Explicit reasoning-effort override sent to OpenAI-compatible endpoints.
   * When unset, OpenAIProvider falls back to its name-based heuristic
   * (gpt-5/o-series get 'none' with tools — forka #13). Explicit wins:
   * e.g. stealth/ox-alpha REJECTS 'none' (reasoning is mandatory) and wants 'low'.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  allowRawMedicalMedia?: boolean;
  /**
   * P2b spec 14 §3 / DD4 — the model's context window in tokens, for the session-window fill triggers.
   * When unset, the SessionManager falls back to the per-model `contextWindowFor` table. Wizard-probed
   * for Ollama; table-seeded for cloud.
   */
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

export interface MemoryConfig {
  workspace: string;
  search: {
    hybridWeights: { vector: number; keyword: number };
  };
  bootstrapMaxChars: number;
  /** MEMORY.md per-section budget shares (E1.4); defaults 0.6 / 0.2 / 0.2. */
  budgetRatios?: { health: number; life: number; agent: number };
}

/**
 * P2b spec 14 §3 — real-token window triggers. Percentages of the effective context window
 * (`providers.main.contextWindow` else the per-model table). Optional in the type so pre-P2b config
 * literals still compile; `DEFAULT_CONFIG` supplies it and `deepMerge` fills it into partial configs.
 */
export interface SessionWindowConfig {
  pruneAtPercent: number;
  compactAtPercent: number;
  emergencyAtPercent: number;
  keepRecentTurns: number;
}

export interface SessionsConfig {
  /** @deprecated P2b: idle resets are retired (DD10). Read for one release; warns; triggers nothing. */
  softResetAfterMinutes: number;
  /** @deprecated P2b: idle resets are retired (DD10). Read for one release; warns; triggers nothing. */
  hardResetAfterMinutes: number;
  compaction: {
    enabled: boolean;
    triggerAtTokenPercent: number;
    memoryFlush: boolean;
    keepRecentTurns: number;
  };
  /** P2b spec 14 §3 window triggers (defaults 35/50/80/10). */
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

export interface EmergencyConfig {
  /** Literal phrases that extend the built-in emergency detector. */
  keywords: string[];
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
  emergency?: EmergencyConfig;
  profiles?: ProfileConfig;
}
