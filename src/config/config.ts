// src/config/config.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSON5 from 'json5';
import type { AppConfig } from './types';

const DEFAULTS: AppConfig = {
  providers: {
    main: {
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
    },
    medical: {
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'amsaravi/medgemma-4b-it:q8',
    },
    embeddings: {
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'nomic-embed-text',
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
};

function resolvePath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      typeof target[key] === 'object' &&
      target[key] !== null
    ) {
      result[key] = deepMerge(target[key] as object, sourceVal as object) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[keyof T];
    }
  }
  return result;
}

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const resolvedPath = configPath ?? path.join(os.homedir(), '.redacted', 'config.json');

  if (!fs.existsSync(resolvedPath)) {
    console.warn(`[config] No config file at ${resolvedPath}, using defaults`);
    return { ...DEFAULTS };
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const userConfig = JSON5.parse(raw) as Partial<AppConfig>;
  const merged = deepMerge(DEFAULTS, userConfig);

  // Resolve ~ in paths
  merged.memory.workspace = resolvePath(merged.memory.workspace);
  merged.heartbeat.storePath = resolvePath(merged.heartbeat.storePath);
  merged.heartbeat.audit!.path = resolvePath(merged.heartbeat.audit!.path);

  return merged;
}
