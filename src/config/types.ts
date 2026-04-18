// src/config/types.ts

export interface ProviderConfig {
  type: 'ollama' | 'openai' | 'anthropic' | 'google';
  baseUrl?: string;
  model: string;
  apiKey?: string;
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

export interface HeartbeatConfig {
  enabled: boolean;
  timezone: string;
  storePath: string;
}

export interface AgentConfig {
  maxIterations: number;
  disclaimerEnabled: boolean;
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
}
