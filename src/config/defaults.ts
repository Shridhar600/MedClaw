import * as os from 'os';
import * as path from 'path';
import type { AppConfig } from './types';
import { BUILT_IN_EMERGENCY_KEYWORDS } from '../safety/emergency-detector';

export const DEFAULT_CONFIG: AppConfig = {
  providers: {
    main: {
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'kimi-k2.5:cloud',
    },
    medical: {
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
    },
    embeddings: {
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'embeddinggemma:latest',
    },
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: '',
    },
  },
  tools: {
    allow: ['*'],
    deny: ['exec'],
  },
  memory: {
    workspace: path.join(os.homedir(), '.redacted', 'workspace'),
    search: {
      hybridWeights: { vector: 0.7, keyword: 0.3 },
    },
    bootstrapMaxChars: 20000,
    budgetRatios: { health: 0.6, life: 0.2, agent: 0.2 },
  },
  sessions: {
    softResetAfterMinutes: 240,
    hardResetAfterMinutes: 1440,
    compaction: {
      enabled: true,
      triggerAtTokenPercent: 80,
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
    storePath: path.join(os.homedir(), '.redacted', 'heartbeats', 'jobs.json'),
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
    audit: {
      path: path.join(os.homedir(), '.redacted', 'heartbeats', 'audit.jsonl'),
    },
  },
  agent: {
    maxIterations: 15,
    disclaimerEnabled: true,
  },
  emergency: {
    keywords: [...BUILT_IN_EMERGENCY_KEYWORDS],
  },
  profiles: {
    baseDir: path.join(os.homedir(), '.redacted'),
    defaultProfileId: 'default',
  },
};

export function cloneDefaultConfig(): AppConfig {
  return structuredClone(DEFAULT_CONFIG);
}
