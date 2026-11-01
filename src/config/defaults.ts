import { BUILT_IN_EMERGENCY_KEYWORDS } from '../safety/emergency-detector';
import { CONFIG_SCHEMA_VERSION, type StoredConfig } from './types';

export const LOCAL_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export const DEFAULT_STORED_CONFIG: StoredConfig = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  providers: {
    main: {
      type: 'ollama',
      baseUrl: LOCAL_OLLAMA_BASE_URL,
      model: 'kimi-k2.5:cloud',
    },
    medical: {
      type: 'ollama',
      baseUrl: LOCAL_OLLAMA_BASE_URL,
      model: 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
    },
    embeddings: {
      type: 'ollama',
      baseUrl: LOCAL_OLLAMA_BASE_URL,
      model: 'embeddinggemma:latest',
    },
  },
  channels: {
    telegram: {
      enabled: false,
      botToken: '',
    },
  },
  tools: {
    allow: ['*'],
    deny: ['exec'],
  },
  memory: {
    search: {
      hybridWeights: { vector: 0.7, keyword: 0.3 },
    },
    bootstrapMaxChars: 20000,
    budgetRatios: { health: 0.6, life: 0.2, agent: 0.2 },
  },
  sessions: {
    compaction: {
      enabled: true,
      memoryFlush: true,
      keepRecentTurns: 10,
    },
    window: {
      pruneAtPercent: 35,
      compactAtPercent: 50,
      emergencyAtPercent: 80,
      keepRecentTurns: 10,
    },
  },
  heartbeat: {
    enabled: true,
    timezone: 'Asia/Kolkata',
    policy: {
      quietHours: {
        enabled: true,
        start: '22:00',
        end: '07:00',
      },
      skipIfChatActiveWithinMinutes: 60,
      defaults: {
        morningCheckIn: {
          enabled: true,
          cron: '0 8 * * *',
          prompt:
            'Ask how the user is feeling this morning and whether there is anything health-related to address today.',
        },
        eveningSummary: {
          enabled: true,
          cron: '0 21 * * *',
          prompt:
            'Ask for a short end-of-day health summary, medication adherence, and anything to remember for tomorrow.',
        },
      },
    },
    recovery: {
      enabled: false,
      windowMinutes: 60,
    },
    retry: {
      maxRetries: 3,
      backoffMinutes: 5,
    },
    rateLimit: {
      maxGlobalTriggersPerMinute: 10,
      maxPerChatTriggersPerMinute: 3,
    },
  },
  agent: {
    maxIterations: 15,
  },
  emergency: {
    keywords: [...BUILT_IN_EMERGENCY_KEYWORDS],
  },
  profiles: {
    baseDir: '~/.redacted',
    defaultProfileId: 'default',
  },
}) as StoredConfig;

/**
 * Deep copy so a caller can never mutate the shared defaults.
 */
export function cloneStoredDefaults(): StoredConfig {
  return structuredClone(DEFAULT_STORED_CONFIG);
}

export const DEFAULT_SESSION_WINDOW = DEFAULT_STORED_CONFIG.sessions.window as NonNullable<
  StoredConfig['sessions']['window']
>;
