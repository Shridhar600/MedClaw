// Two distinct types by design: the source schema and the effective configuration are separate.
//
//   StoredConfig    - the persisted document (schemaVersion 2). Carries owner identity and the
//                     owner-scoped base directory. It never carries derived paths, so there is no
//                     second path authority to disagree with.
//   EffectiveConfig - the runtime shape consumers read: `StoredConfig` plus the owner paths resolved
//                     once from `resolveOwnerPaths`, so stores stay path-agnostic.
//
// Nothing here reads a file. Disk IO lives in `src/runtime/adapters/config-file.ts`.

export const CONFIG_SCHEMA_VERSION = 2 as const;

export interface ProviderConfig {
  type: 'ollama' | 'openai' | 'anthropic' | 'google' | 'openrouter';
  baseUrl?: string;
  model: string;
  apiKey?: string;
  /**
   * Explicit reasoning-effort override sent to OpenAI-compatible endpoints.
   * When unset, OpenAIProvider falls back to its name-based heuristic. Explicit wins: some
   * endpoints reject 'none' because reasoning is mandatory, and want 'low'.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  allowRawMedicalMedia?: boolean;
  /**
   * The model's context window in tokens, for the session-window fill triggers. When unset, the
   * SessionManager falls back to the per-model `contextWindowFor` table. Wizard-probed for Ollama;
   * table-seeded for cloud.
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

/**
 * Real-token window triggers, as percentages of the effective context window
 * (`providers.main.contextWindow` else the per-model table). `src/gateway/session.ts` reads these
 * through `windowThresholds()`; the defaults live only in `defaults.ts`.
 */
export interface SessionWindowConfig {
  pruneAtPercent: number;
  compactAtPercent: number;
  emergencyAtPercent: number;
  keepRecentTurns: number;
}

export interface SessionsConfig {
  /**
   * No longer drives idle resets. The key stays in the stored schema, the values are still passed
   * to SessionManager construction, and `config set` refuses to change it.
   */
  softResetAfterMinutes: number;
  /** @see softResetAfterMinutes */
  hardResetAfterMinutes: number;
  compaction: {
    enabled: boolean;
    triggerAtTokenPercent: number;
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
  disclaimerEnabled: boolean;
}

export interface EmergencyConfig {
  /** Literal phrases that extend the built-in emergency detector. Built-ins are always kept. */
  keywords: string[];
}

/**
 * The selected owner's identity and owner-scoped base directory. Mandatory in
 * `schemaVersion: 2`: a document without it cannot serve, because identity must never
 * be inferred from defaults.
 */
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

/**
 * The owner paths the effective config needs. Structurally satisfied by `OwnerPaths` from
 * `src/profiles/paths.ts` without this module importing the profiles module.
 */
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

/**
 * What every runtime consumer receives: the stored config with the workspace, scheduler store path
 * and audit path supplied by derivation instead of a second persisted authority.
 */
export interface EffectiveConfig extends Omit<StoredConfig, 'memory' | 'heartbeat'> {
  memory: EffectiveMemoryConfig;
  heartbeat: EffectiveHeartbeatConfig;
}

/** Provider env-var name for a provider type. `ollama` is local and needs no key. */
export type ProviderType = ProviderConfig['type'];
