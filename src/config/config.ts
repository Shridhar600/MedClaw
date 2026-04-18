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

  return merged;
}
