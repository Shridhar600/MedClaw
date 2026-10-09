// src/config/validation.ts
//
// Total decoder for the persisted `schemaVersion: 2` document, plus the semantic
// validator shared by every consumer (startup, `config set`, wizard, readiness).
//
// Rules that are deliberate, because each replaces a live defect:
//
//  - Input is `unknown`. No cast, no deep-merge-as-validation. A document that is not
//    an object, or whose nesting/types are wrong, is refused with an allowlisted
//    field/reason. Input VALUES are never included in a message.
//  - Unknown keys are refused, not merged. `heartbeat.storepath` used to load and then be
//    re-persisted forever.
//  - Prototype keys are refused at every level.
//  - The retired derived-path keys (`memory.workspace`, `heartbeat.storePath`,
//    `heartbeat.audit`) are refused with setup guidance instead of being migrated or
//    silently ignored, so there is never a second path authority.
//  - Identity is required: `profiles.baseDir` and `profiles.defaultProfileId`. A document
//    without them cannot serve, because a default must never become an owner.
//  - Defaults fill only omitted NON-IDENTITY settings, and only after the supplied shape
//    has been validated.
//  - Built-in emergency keywords are always retained; configured keywords are added only
//    when they are valid non-empty strings.
//
// Pure: no filesystem access. `homeDir` is injected so `~/` expansion is testable.

import * as path from 'path';
import * as cron from 'node-cron';
import {
  CONFIG_SCHEMA_VERSION,
  type EffectiveConfig,
  type ProviderConfig,
  type ProviderType,
  type SessionsConfig,
  type StoredConfig,
} from './types';
import { cloneStoredDefaults, LOCAL_OLLAMA_BASE_URL } from './defaults';
import { BUILT_IN_EMERGENCY_KEYWORDS } from '../safety/emergency-detector';
import { providerEnvVar } from './provider-env';
import type { ConfigSetPath } from './set-path';
import { isCronValidationWorkBounded } from './cron-resource-policy';

export const OWNER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Keys that were valid persisted path authorities before `schemaVersion: 2`. */
export const RETIRED_PATH_KEYS: ReadonlyArray<{ field: string; guidance: string }> = [
  {
    field: 'memory.workspace',
    guidance:
      'The owner workspace is derived from profiles.baseDir and profiles.defaultProfileId. Remove memory.workspace and re-run setup.',
  },
  {
    field: 'heartbeat.storePath',
    guidance:
      'The heartbeat store is derived inside the selected owner workspace. Remove heartbeat.storePath and re-run setup.',
  },
  {
    field: 'heartbeat.audit',
    guidance:
      'The audit log is derived inside the selected owner workspace. Remove heartbeat.audit and re-run setup.',
  },
  {
    field: 'heartbeat.audit.path',
    guidance:
      'The audit log is derived inside the selected owner workspace. Remove heartbeat.audit and re-run setup.',
  },
];

/** Keys `config set` refuses to change because they select identity or are derived. */
export const PROTECTED_SET_PATHS: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: 'schemaVersion', reason: 'the persisted schema version is set by setup, not by config set' },
  { prefix: 'profiles', reason: 'owner identity and the owner base directory are selected during setup' },
  { prefix: 'memory.workspace', reason: 'the owner workspace is derived from the selected owner' },
  {
    prefix: 'heartbeat.storePath',
    reason: 'the heartbeat store is derived from the selected owner',
  },
  { prefix: 'heartbeat.audit', reason: 'the audit log is derived from the selected owner' },
  {
    prefix: 'sessions.softResetAfterMinutes',
    reason: 'idle resets are retired (P2b DD10); the value is inert',
  },
  {
    prefix: 'sessions.hardResetAfterMinutes',
    reason: 'idle resets are retired (P2b DD10); the value is inert',
  },
];

export type ConfigIssueCode =
  | 'not-an-object'
  | 'invalid-schema-version'
  | 'missing-field'
  | 'unknown-field'
  | 'prototype-field'
  | 'retired-field'
  | 'wrong-type'
  | 'invalid-enum'
  | 'invalid-url'
  | 'out-of-range'
  | 'not-integer'
  | 'weights-not-normalized'
  | 'thresholds-out-of-order'
  | 'invalid-timezone'
  | 'invalid-cron'
  | 'invalid-clock-time'
  | 'invalid-owner-id'
  | 'invalid-absolute-path'
  | 'missing-secret';

export interface ConfigIssue {
  /** Allowlisted code. */
  code: ConfigIssueCode;
  /** Dotted field path. Never a value. */
  field: string;
  /** Short allowlisted explanation. Never an input value. */
  detail: string;
}

export type ConfigDecodeResult =
  | { kind: 'valid'; config: StoredConfig }
  | { kind: 'invalid'; issues: ConfigIssue[] };

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const PROVIDER_TYPES: ReadonlyArray<ProviderType> = ['ollama', 'openai', 'anthropic', 'google', 'openrouter'];
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimezone(value: string): boolean {
  if (value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isValidHttpUrl(value: string): boolean {
  if (value.trim() === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** Expand a leading `~/` against an injected home directory. No other tilde forms are accepted. */
export function expandHomePath(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

/** A configured root must be absolute (after `~/` expansion) and already normalized. */
function isNormalizedAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value && !value.includes('\0');
}

class IssueCollector {
  readonly issues: ConfigIssue[] = [];

  add(code: ConfigIssueCode, field: string, detail: string): void {
    this.issues.push({ code, field, detail });
  }

  get empty(): boolean {
    return this.issues.length === 0;
  }
}

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Closed-schema read of one object level. Reports unknown and prototype keys, and returns
 * only the known keys so a nested reader can never walk an unvalidated branch.
 */
function readObject(
  value: unknown,
  field: string,
  allowed: ReadonlyArray<string>,
  issues: IssueCollector,
): Plain | undefined {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    issues.add('wrong-type', field, 'expected an object');
    return undefined;
  }
  const out: Plain = {};
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.has(key)) {
      issues.add('prototype-field', field, 'prototype keys are refused');
      continue;
    }
    if (!allowed.includes(key)) {
      const unknownPath = field === '' ? key : `${field}.${key}`;
      const retired = RETIRED_PATH_KEYS.find((entry) => entry.field === unknownPath);
      if (retired) {
        issues.add('retired-field', unknownPath, retired.guidance);
      } else {
        issues.add('unknown-field', unknownPath, 'unknown setting; remove it or re-run setup');
      }
      continue;
    }
    out[key] = value[key];
  }
  return out;
}

interface Reader {
  issues: IssueCollector;
  defaults: StoredConfig;
}

function reqString(r: Reader, obj: Plain | undefined, key: string, field: string): string | undefined {
  const raw = obj?.[key];
  if (raw === undefined) {
    r.issues.add('missing-field', field, 'required setting is absent');
    return undefined;
  }
  if (typeof raw !== 'string') {
    r.issues.add('wrong-type', field, 'expected a string');
    return undefined;
  }
  return raw;
}

function optString(r: Reader, obj: Plain | undefined, key: string, field: string, fallback: string): string {
  const raw = obj?.[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string') {
    r.issues.add('wrong-type', field, 'expected a string');
    return fallback;
  }
  return raw;
}

function reqBool(r: Reader, obj: Plain | undefined, key: string, field: string, fallback: boolean): boolean {
  const raw = obj?.[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    r.issues.add('wrong-type', field, 'expected true or false');
    return fallback;
  }
  return raw;
}

function reqNonEmptyString(r: Reader, obj: Plain | undefined, key: string, field: string): string | undefined {
  const value = reqString(r, obj, key, field);
  if (value !== undefined && value.trim() === '') {
    r.issues.add('out-of-range', field, 'must not be empty');
    return undefined;
  }
  return value;
}

function optFiniteNumber(
  r: Reader,
  obj: Plain | undefined,
  key: string,
  field: string,
  fallback: number,
  range: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = obj?.[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    r.issues.add('wrong-type', field, 'expected a finite number');
    return fallback;
  }
  if (range.integer && !Number.isInteger(raw)) {
    r.issues.add('not-integer', field, 'expected a whole number');
    return fallback;
  }
  if (range.min !== undefined && raw < range.min) {
    r.issues.add('out-of-range', field, 'below the allowed minimum');
    return fallback;
  }
  if (range.max !== undefined && raw > range.max) {
    r.issues.add('out-of-range', field, 'above the allowed maximum');
    return fallback;
  }
  return raw;
}

function optStringArray(
  r: Reader,
  obj: Plain | undefined,
  key: string,
  field: string,
  fallback: string[],
): string[] {
  const raw = obj?.[key];
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw)) {
    r.issues.add('wrong-type', field, 'expected a list of strings');
    return [...fallback];
  }
  const out: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string') {
      r.issues.add('wrong-type', `${field}[${index}]`, 'expected a string');
      return [...fallback];
    }
    out.push(entry);
  }
  return out;
}

function readProvider(r: Reader, raw: unknown, field: string, fallback: ProviderConfig): ProviderConfig {
  const obj = readObject(raw, field, [
    'type',
    'baseUrl',
    'model',
    'apiKey',
    'reasoningEffort',
    'allowRawMedicalMedia',
    'contextWindow',
  ], r.issues);
  if (!obj) return { ...fallback };

  const typeRaw = obj.type ?? fallback.type;
  let type: ProviderType = fallback.type;
  if (typeof typeRaw !== 'string' || !PROVIDER_TYPES.includes(typeRaw as ProviderType)) {
    r.issues.add('invalid-enum', `${field}.type`, `expected one of ${PROVIDER_TYPES.join(', ')}`);
  } else {
    type = typeRaw as ProviderType;
  }

  const provider: ProviderConfig = { type, model: optString(r, obj, 'model', `${field}.model`, fallback.model) };

  const baseUrlRaw = obj.baseUrl;
  if (baseUrlRaw !== undefined) {
    if (typeof baseUrlRaw !== 'string') {
      r.issues.add('wrong-type', `${field}.baseUrl`, 'expected a string');
    } else if (baseUrlRaw !== '' && !isValidHttpUrl(baseUrlRaw)) {
      r.issues.add('invalid-url', `${field}.baseUrl`, 'expected an absolute http or https URL');
    } else if (baseUrlRaw !== '') {
      provider.baseUrl = baseUrlRaw;
    }
  } else if (type === 'ollama' && fallback.baseUrl) {
    provider.baseUrl = fallback.baseUrl;
  }

  const apiKeyRaw = obj.apiKey;
  if (typeof apiKeyRaw === 'string') {
    provider.apiKey = apiKeyRaw;
  } else if (apiKeyRaw !== undefined) {
    r.issues.add('wrong-type', `${field}.apiKey`, 'expected a string');
  } else if (fallback.apiKey !== undefined && type !== 'ollama') {
    provider.apiKey = fallback.apiKey;
  }

  if (obj.reasoningEffort !== undefined) {
    if (typeof obj.reasoningEffort === 'string' && (REASONING_EFFORTS as ReadonlyArray<string>).includes(obj.reasoningEffort)) {
      provider.reasoningEffort = obj.reasoningEffort as ProviderConfig['reasoningEffort'];
    } else {
      r.issues.add('invalid-enum', `${field}.reasoningEffort`, `expected one of ${REASONING_EFFORTS.join(', ')}`);
    }
  }
  if (obj.allowRawMedicalMedia !== undefined) {
    if (typeof obj.allowRawMedicalMedia === 'boolean') {
      provider.allowRawMedicalMedia = obj.allowRawMedicalMedia;
    } else {
      r.issues.add('wrong-type', `${field}.allowRawMedicalMedia`, 'expected true or false');
    }
  }
  if (obj.contextWindow !== undefined) {
    provider.contextWindow = optFiniteNumber(r, obj, 'contextWindow', `${field}.contextWindow`, 0, {
      min: 1,
      integer: true,
    });
  }
  return provider;
}

/**
 * Is this URL the known local Ollama endpoint, however it is spelled?
 *
 * An exact string comparison is too shallow a guard: `http://localhost:11434/v1/`,
 * `HTTP://LOCALHOST:11434/v1` and `http://localhost:11434/v1` are the SAME endpoint, and a guard
 * that refuses only one spelling is not a guard. This normalisation exists only to recognise that
 * one known default. It is not a general endpoint policy: a private or loopback proxy at any other
 * URL is still a legal operator choice (PD-8 — self-hosted paths are first-class).
 */
function isLocalOllamaBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === LOCAL_OLLAMA_BASE_URL) return true;
  let parsed: URL;
  let local: URL;
  try {
    parsed = new URL(trimmed);
    local = new URL(LOCAL_OLLAMA_BASE_URL);
  } catch {
    return false;
  }
  // A trailing dot is the same DNS name (`localhost.` === `localhost`). Userinfo does NOT make it a
  // different endpoint — `http://user:pass@localhost:11434/v1` still points at the local Ollama
  // endpoint, so it must be caught too. (Cold re-review: userinfo and trailing-dot spellings
  // bypassed the guard.) The comparison intentionally ignores only these spelling differences; it
  // does not treat 127.0.0.1 as the same name, so a proxy bound there stays a legal cloud endpoint
  // under PD-8's self-hosted allowance.
  const host = (url: URL): string => url.hostname.toLowerCase().replace(/\.+$/, '');
  // Percent-escapes are an alternative spelling of the same path: `/%76%31` decodes to `/v1`, so a
  // comparison on the raw pathname would let a disguised local endpoint through. A malformed escape
  // is left as-is; the value still had to parse as a URL above.
  const decodePath = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const samePath = decodePath(parsed.pathname).replace(/\/+$/, '')
    === decodePath(local.pathname).replace(/\/+$/, '');
  return parsed.protocol === local.protocol
    && host(parsed) === host(local)
    && parsed.port === local.port
    && samePath;
}

/**
 * Per-role base URL policy.
 *
 * A LOCAL role must carry its local endpoint. A CLOUD role may carry an explicit endpoint —
 * OpenRouter has no SDK default of its own, so setup writes its router URL and the document has
 * to be able to keep it — but it must never carry the known local Ollama endpoint, which is the
 * concrete inheritance mistake plan 15 §2.1 forbids ("cloud provider selection never inherits a
 * local base URL").
 *
 * The rule is deliberately narrow. It is NOT a blanket ban on cloud base URLs (that blanket ban
 * was finding R04: supported OpenRouter setup could not be saved or reloaded), and it is NOT an
 * SSRF/endpoint policy platform. Structural validity of the URL is decided separately and earlier
 * by `isValidHttpUrl`, which still refuses a non-http(s) scheme or an unparseable string.
 */
function checkProviderBaseUrl(r: Reader, provider: ProviderConfig, field: string): void {
  if (provider.type === 'ollama') {
    if (!provider.baseUrl) {
      r.issues.add('missing-secret', `${field}.baseUrl`, 'a local provider requires its base URL');
    }
    return;
  }
  if (provider.baseUrl !== undefined && isLocalOllamaBaseUrl(provider.baseUrl)) {
    r.issues.add(
      'invalid-url',
      `${field}.baseUrl`,
      'a cloud provider must not carry the local Ollama base URL',
    );
  }
}

function readSessions(r: Reader, raw: unknown): SessionsConfig {
  const d = r.defaults.sessions;
  const obj = readObject(raw, 'sessions', ['softResetAfterMinutes', 'hardResetAfterMinutes', 'compaction', 'window'], r.issues);
  if (!obj) return structuredClone(d);

  const compactionRaw = readObject(obj.compaction, 'sessions.compaction', ['enabled', 'triggerAtTokenPercent', 'memoryFlush', 'keepRecentTurns'], r.issues);
  const compaction = {
    enabled: reqBool(r, compactionRaw, 'enabled', 'sessions.compaction.enabled', d.compaction.enabled),
    triggerAtTokenPercent: optFiniteNumber(r, compactionRaw, 'triggerAtTokenPercent', 'sessions.compaction.triggerAtTokenPercent', d.compaction.triggerAtTokenPercent, { min: 1, max: 100 }),
    memoryFlush: reqBool(r, compactionRaw, 'memoryFlush', 'sessions.compaction.memoryFlush', d.compaction.memoryFlush),
    keepRecentTurns: optFiniteNumber(r, compactionRaw, 'keepRecentTurns', 'sessions.compaction.keepRecentTurns', d.compaction.keepRecentTurns, { min: 1, integer: true }),
  };

  const windowRaw = readObject(obj.window, 'sessions.window', ['pruneAtPercent', 'compactAtPercent', 'emergencyAtPercent', 'keepRecentTurns'], r.issues);
  const dw = d.window ?? { pruneAtPercent: 35, compactAtPercent: 50, emergencyAtPercent: 80, keepRecentTurns: 10 };
  const win = {
    pruneAtPercent: optFiniteNumber(r, windowRaw, 'pruneAtPercent', 'sessions.window.pruneAtPercent', dw.pruneAtPercent, { min: 0, max: 100 }),
    compactAtPercent: optFiniteNumber(r, windowRaw, 'compactAtPercent', 'sessions.window.compactAtPercent', dw.compactAtPercent, { min: 0, max: 100 }),
    emergencyAtPercent: optFiniteNumber(r, windowRaw, 'emergencyAtPercent', 'sessions.window.emergencyAtPercent', dw.emergencyAtPercent, { min: 0, max: 100 }),
    keepRecentTurns: optFiniteNumber(r, windowRaw, 'keepRecentTurns', 'sessions.window.keepRecentTurns', dw.keepRecentTurns, { min: 1, integer: true }),
  };
  if (!(win.pruneAtPercent > 0 && win.pruneAtPercent < win.compactAtPercent && win.compactAtPercent < win.emergencyAtPercent && win.emergencyAtPercent <= 100)) {
    r.issues.add('thresholds-out-of-order', 'sessions.window', 'expected 0 < pruneAtPercent < compactAtPercent < emergencyAtPercent <= 100');
  }

  return {
    softResetAfterMinutes: optFiniteNumber(r, obj, 'softResetAfterMinutes', 'sessions.softResetAfterMinutes', d.softResetAfterMinutes, { min: 0, integer: true }),
    hardResetAfterMinutes: optFiniteNumber(r, obj, 'hardResetAfterMinutes', 'sessions.hardResetAfterMinutes', d.hardResetAfterMinutes, { min: 0, integer: true }),
    compaction,
    window: win,
  };
}

function readHeartbeat(r: Reader, raw: unknown): StoredConfig['heartbeat'] {
  const d = r.defaults.heartbeat;
  const obj = readObject(raw, 'heartbeat', ['enabled', 'timezone', 'policy', 'recovery', 'retry', 'rateLimit'], r.issues);
  if (!obj) return structuredClone(d);

  const timezone = optString(r, obj, 'timezone', 'heartbeat.timezone', d.timezone);
  if (!isValidTimezone(timezone)) {
    r.issues.add('invalid-timezone', 'heartbeat.timezone', 'expected an IANA time zone such as Asia/Kolkata');
  }

  const policyRaw = readObject(obj.policy, 'heartbeat.policy', ['quietHours', 'skipIfChatActiveWithinMinutes', 'defaults'], r.issues);
  const quietRaw = readObject(policyRaw?.quietHours, 'heartbeat.policy.quietHours', ['enabled', 'start', 'end'], r.issues);
  const quiet = {
    enabled: reqBool(r, quietRaw, 'enabled', 'heartbeat.policy.quietHours.enabled', d.policy.quietHours.enabled),
    start: optString(r, quietRaw, 'start', 'heartbeat.policy.quietHours.start', d.policy.quietHours.start),
    end: optString(r, quietRaw, 'end', 'heartbeat.policy.quietHours.end', d.policy.quietHours.end),
  };
  for (const key of ['start', 'end'] as const) {
    if (quiet.enabled && !CLOCK_TIME.test(quiet[key])) {
      r.issues.add('invalid-clock-time', `heartbeat.policy.quietHours.${key}`, 'expected HH:MM in 24-hour form');
    }
  }

  const defaultsRaw = readObject(policyRaw?.defaults, 'heartbeat.policy.defaults', ['morningCheckIn', 'eveningSummary'], r.issues);
  const readJob = (key: 'morningCheckIn' | 'eveningSummary'): StoredConfig['heartbeat']['policy']['defaults']['morningCheckIn'] => {
    const field = `heartbeat.policy.defaults.${key}`;
    const jobRaw = readObject(defaultsRaw?.[key], field, ['enabled', 'cron', 'prompt'], r.issues);
    const fallback = d.policy.defaults[key];
    const cron = optString(r, jobRaw, 'cron', `${field}.cron`, fallback.cron);
    return {
      enabled: reqBool(r, jobRaw, 'enabled', `${field}.enabled`, fallback.enabled),
      cron,
      prompt: optString(r, jobRaw, 'prompt', `${field}.prompt`, fallback.prompt),
    };
  };

  const recoveryRaw = readObject(obj.recovery, 'heartbeat.recovery', ['enabled', 'windowMinutes'], r.issues);
  const retryRaw = readObject(obj.retry, 'heartbeat.retry', ['maxRetries', 'backoffMinutes'], r.issues);
  const rateRaw = readObject(obj.rateLimit, 'heartbeat.rateLimit', ['maxGlobalTriggersPerMinute', 'maxPerChatTriggersPerMinute'], r.issues);

  return {
    enabled: reqBool(r, obj, 'enabled', 'heartbeat.enabled', d.enabled),
    timezone,
    policy: {
      quietHours: quiet,
      skipIfChatActiveWithinMinutes: optFiniteNumber(r, policyRaw, 'skipIfChatActiveWithinMinutes', 'heartbeat.policy.skipIfChatActiveWithinMinutes', d.policy.skipIfChatActiveWithinMinutes, { min: 0, integer: true }),
      defaults: { morningCheckIn: readJob('morningCheckIn'), eveningSummary: readJob('eveningSummary') },
    },
    recovery: {
      enabled: reqBool(r, recoveryRaw, 'enabled', 'heartbeat.recovery.enabled', d.recovery.enabled),
      windowMinutes: optFiniteNumber(r, recoveryRaw, 'windowMinutes', 'heartbeat.recovery.windowMinutes', d.recovery.windowMinutes, { min: 0, integer: true }),
    },
    retry: {
      maxRetries: optFiniteNumber(r, retryRaw, 'maxRetries', 'heartbeat.retry.maxRetries', d.retry.maxRetries, { min: 0, integer: true }),
      backoffMinutes: optFiniteNumber(r, retryRaw, 'backoffMinutes', 'heartbeat.retry.backoffMinutes', d.retry.backoffMinutes, { min: 0 }),
    },
    rateLimit: {
      maxGlobalTriggersPerMinute: optFiniteNumber(r, rateRaw, 'maxGlobalTriggersPerMinute', 'heartbeat.rateLimit.maxGlobalTriggersPerMinute', d.rateLimit.maxGlobalTriggersPerMinute, { min: 0, integer: true }),
      maxPerChatTriggersPerMinute: optFiniteNumber(r, rateRaw, 'maxPerChatTriggersPerMinute', 'heartbeat.rateLimit.maxPerChatTriggersPerMinute', d.rateLimit.maxPerChatTriggersPerMinute, { min: 0, integer: true }),
    },
  };
}

/** Shared semantic checks. Used by the decoder and by `validateConfig`, so one rule set exists. */
function semanticIssues(stored: StoredConfig): ConfigIssue[] {
  const issues = new IssueCollector();
  const r: Reader = { issues, defaults: cloneStoredDefaults() };

  checkProviderBaseUrl(r, stored.providers.main, 'providers.main');
  checkProviderBaseUrl(r, stored.providers.medical, 'providers.medical');
  checkProviderBaseUrl(r, stored.providers.embeddings, 'providers.embeddings');

  for (const key of ['main', 'medical', 'embeddings'] as const) {
    if (stored.providers[key].model.trim() === '') {
      r.issues.add('out-of-range', `providers.${key}.model`, 'must not be empty');
    }
  }

  // A token is required exactly when telegram is enabled. A disabled channel is a truthful
  // "configured, pairing-pending" state, not an error; `validateConfig` reports it as a
  // warning so no one mistakes it for a working owner conversation.
  if (stored.channels.telegram.enabled && stored.channels.telegram.botToken.trim() === '') {
    r.issues.add('missing-secret', 'channels.telegram.botToken', 'telegram is enabled but no bot token is set');
  }

  const { vector, keyword } = stored.memory.search.hybridWeights;
  if (vector < 0 || keyword < 0 || vector > 1 || keyword > 1) {
    r.issues.add('out-of-range', 'memory.search.hybridWeights', 'each weight must be within [0, 1]');
  } else if (Math.abs(vector + keyword - 1) > 1e-9) {
    r.issues.add('weights-not-normalized', 'memory.search.hybridWeights', 'vector and keyword weights must sum to 1');
  }

  const ratios = stored.memory.budgetRatios;
  if (ratios) {
    const sum = ratios.health + ratios.life + ratios.agent;
    if (ratios.health < 0 || ratios.life < 0 || ratios.agent < 0 || ratios.health > 1 || ratios.life > 1 || ratios.agent > 1) {
      r.issues.add('out-of-range', 'memory.budgetRatios', 'each share must be within [0, 1]');
    } else if (Math.abs(sum - 1) > 1e-9) {
      r.issues.add('weights-not-normalized', 'memory.budgetRatios', 'budget shares must sum to 1');
    }
  }

  if (stored.memory.bootstrapMaxChars <= 0) {
    r.issues.add('out-of-range', 'memory.bootstrapMaxChars', 'must be greater than zero');
  }

  if (!Number.isInteger(stored.agent.maxIterations) || stored.agent.maxIterations <= 0) {
    r.issues.add('out-of-range', 'agent.maxIterations', 'must be a whole number greater than zero');
  }

  if (!isValidTimezone(stored.heartbeat.timezone)) {
    r.issues.add('invalid-timezone', 'heartbeat.timezone', 'expected an IANA time zone such as Asia/Kolkata');
  }

  // Bound conversion before the scheduler's expanding validator. Both defaults are checked,
  // including disabled ones and already-constructed configs passed to validateConfig.
  for (const key of ['morningCheckIn', 'eveningSummary'] as const) {
    const expression = stored.heartbeat.policy.defaults[key].cron;
    if (!isCronValidationWorkBounded(expression)) {
      r.issues.add('invalid-cron', `heartbeat.policy.defaults.${key}.cron`, 'cron expression exceeds safe validation limits');
    } else if (!cron.validate(expression)) {
      r.issues.add('invalid-cron', `heartbeat.policy.defaults.${key}.cron`, 'expected a cron expression supported by the scheduler');
    }
  }

  return r.issues.issues;
}

/** Human-readable, value-free issue line used by the CLI. */
export function formatConfigIssue(issue: ConfigIssue): string {
  return `${issue.field}: ${issue.detail} [${issue.code}]`;
}

function readEmergencyKeywords(r: Reader, raw: unknown): string[] {
  const obj = readObject(raw, 'emergency', ['keywords'], r.issues);
  const supplied = optStringArray(r, obj, 'keywords', 'emergency.keywords', []);
  const builtIn = new Set<string>(BUILT_IN_EMERGENCY_KEYWORDS);
  const extra: string[] = [];
  for (const [index, keyword] of supplied.entries()) {
    if (keyword.trim() === '') {
      r.issues.add('out-of-range', `emergency.keywords[${index}]`, 'must not be empty');
      continue;
    }
    if (builtIn.has(keyword)) continue;
    if (extra.includes(keyword)) continue;
    extra.push(keyword);
  }
  // Built-ins are always retained (specs: emergency keywords cannot be removed by config).
  return [...BUILT_IN_EMERGENCY_KEYWORDS, ...extra];
}

/**
 * Decode an unknown value into a validated `StoredConfig`.
 *
 * Never throws for bad input: returns typed issues so a caller can refuse honestly and
 * keep the original bytes on disk.
 */
export function decodeStoredConfig(
  input: unknown,
  options: { homeDir: string },
): ConfigDecodeResult {
  const issues = new IssueCollector();
  if (!isPlainObject(input)) {
    return { kind: 'invalid', issues: [{ code: 'not-an-object', field: '', detail: 'expected a configuration object' }] };
  }

  const version = input.schemaVersion;
  if (version !== CONFIG_SCHEMA_VERSION) {
    issues.add(
      'invalid-schema-version',
      'schemaVersion',
      `expected ${CONFIG_SCHEMA_VERSION}; this build only serves schemaVersion ${CONFIG_SCHEMA_VERSION} documents, so re-run setup`,
    );
  }

  const defaults = cloneStoredDefaults();
  const r: Reader = { issues, defaults };
  const root = readObject(input, '', [
    'schemaVersion',
    'providers',
    'channels',
    'tools',
    'memory',
    'sessions',
    'heartbeat',
    'agent',
    'emergency',
    'profiles',
  ], issues);
  if (!root) return { kind: 'invalid', issues: issues.issues };

  // --- identity: mandatory, never defaulted -------------------------------------------
  const profilesRaw = readObject(root.profiles, 'profiles', ['baseDir', 'defaultProfileId'], issues);
  const baseDirRaw = reqNonEmptyString(r, profilesRaw, 'baseDir', 'profiles.baseDir');
  const ownerIdRaw = reqNonEmptyString(r, profilesRaw, 'defaultProfileId', 'profiles.defaultProfileId');
  let baseDir = defaults.profiles.baseDir;
  let ownerId = defaults.profiles.defaultProfileId;
  if (baseDirRaw !== undefined) {
    const expanded = expandHomePath(baseDirRaw, options.homeDir);
    if (!isNormalizedAbsolutePath(expanded)) {
      issues.add('invalid-absolute-path', 'profiles.baseDir', 'expected an absolute normalized path, or a ~/ path');
    } else {
      baseDir = expanded;
    }
  }
  if (ownerIdRaw !== undefined) {
    if (!OWNER_ID_PATTERN.test(ownerIdRaw)) {
      issues.add('invalid-owner-id', 'profiles.defaultProfileId', 'expected lowercase letters, digits and dashes, starting with a letter or digit, up to 64 characters');
    } else {
      ownerId = ownerIdRaw;
    }
  }

  // --- providers ------------------------------------------------------------------------
  const providersRaw = readObject(root.providers, 'providers', ['main', 'medical', 'embeddings'], issues);
  const providers = {
    main: readProvider(r, providersRaw?.main, 'providers.main', defaults.providers.main),
    medical: readProvider(r, providersRaw?.medical, 'providers.medical', defaults.providers.medical),
    embeddings: readProvider(r, providersRaw?.embeddings, 'providers.embeddings', defaults.providers.embeddings),
  };

  // --- channels -------------------------------------------------------------------------
  const channelsRaw = readObject(root.channels, 'channels', ['telegram'], issues);
  const telegramRaw = readObject(channelsRaw?.telegram, 'channels.telegram', ['enabled', 'botToken'], issues);
  const channels = {
    telegram: {
      enabled: reqBool(r, telegramRaw, 'enabled', 'channels.telegram.enabled', defaults.channels.telegram.enabled),
      botToken: optString(r, telegramRaw, 'botToken', 'channels.telegram.botToken', defaults.channels.telegram.botToken),
    },
  };

  // --- tools ----------------------------------------------------------------------------
  const toolsRaw = readObject(root.tools, 'tools', ['allow', 'deny'], issues);
  const tools = {
    allow: optStringArray(r, toolsRaw, 'allow', 'tools.allow', defaults.tools.allow),
    deny: optStringArray(r, toolsRaw, 'deny', 'tools.deny', defaults.tools.deny),
  };

  // --- memory ----------------------------------------------------------------------------
  const memoryRaw = readObject(root.memory, 'memory', ['search', 'bootstrapMaxChars', 'budgetRatios'], issues);
  const searchRaw = readObject(memoryRaw?.search, 'memory.search', ['hybridWeights'], issues);
  const weightsRaw = readObject(searchRaw?.hybridWeights, 'memory.search.hybridWeights', ['vector', 'keyword'], issues);
  const ratiosRaw = readObject(memoryRaw?.budgetRatios, 'memory.budgetRatios', ['health', 'life', 'agent'], issues);
  const memory: StoredConfig['memory'] = {
    search: {
      hybridWeights: {
        vector: optFiniteNumber(r, weightsRaw, 'vector', 'memory.search.hybridWeights.vector', defaults.memory.search.hybridWeights.vector, { min: 0, max: 1 }),
        keyword: optFiniteNumber(r, weightsRaw, 'keyword', 'memory.search.hybridWeights.keyword', defaults.memory.search.hybridWeights.keyword, { min: 0, max: 1 }),
      },
    },
    bootstrapMaxChars: optFiniteNumber(r, memoryRaw, 'bootstrapMaxChars', 'memory.bootstrapMaxChars', defaults.memory.bootstrapMaxChars, { min: 1, integer: true }),
  };
  if (ratiosRaw) {
    memory.budgetRatios = {
      health: optFiniteNumber(r, ratiosRaw, 'health', 'memory.budgetRatios.health', defaults.memory.budgetRatios!.health, { min: 0, max: 1 }),
      life: optFiniteNumber(r, ratiosRaw, 'life', 'memory.budgetRatios.life', defaults.memory.budgetRatios!.life, { min: 0, max: 1 }),
      agent: optFiniteNumber(r, ratiosRaw, 'agent', 'memory.budgetRatios.agent', defaults.memory.budgetRatios!.agent, { min: 0, max: 1 }),
    };
  } else {
    memory.budgetRatios = structuredClone(defaults.memory.budgetRatios);
  }

  // --- sessions / heartbeat / agent -------------------------------------------------------
  const sessions = readSessions(r, root.sessions);
  const heartbeat = readHeartbeat(r, root.heartbeat);
  const agentRaw = readObject(root.agent, 'agent', ['maxIterations', 'disclaimerEnabled'], issues);
  const agent = {
    maxIterations: optFiniteNumber(r, agentRaw, 'maxIterations', 'agent.maxIterations', defaults.agent.maxIterations, { min: 1, integer: true }),
    disclaimerEnabled: reqBool(r, agentRaw, 'disclaimerEnabled', 'agent.disclaimerEnabled', defaults.agent.disclaimerEnabled),
  };

  const stored: StoredConfig = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    providers,
    channels,
    tools,
    memory,
    sessions,
    heartbeat,
    agent,
    emergency: { keywords: readEmergencyKeywords(r, root.emergency) },
    profiles: { baseDir, defaultProfileId: ownerId },
  };

  if (!issues.empty) return { kind: 'invalid', issues: issues.issues };

  const semantic = semanticIssues(stored);
  if (semantic.length > 0) return { kind: 'invalid', issues: semantic };

  return { kind: 'valid', config: stored };
}

/**
 * Semantic validation of an already-constructed configuration.
 *
 * Retained because the wizard, `config set` and the start preflight all need an
 * errors/warnings view. It runs the SAME rules as `decodeStoredConfig` — there is no
 * second validator that can disagree with the one startup uses.
 */
export function validateConfig(config: EffectiveConfig): ConfigValidationResult {
  const stored = toStoredView(config);
  const issues = semanticIssues(stored);
  const errors = issues.map(formatConfigIssue);
  const warnings: string[] = [];

  const requiredEnv = (provider: ProviderConfig, field: string): void => {
    if (provider.type === 'ollama') return;
    if ((provider.apiKey ?? '').trim() === '') {
      const envName: string | undefined = providerEnvVar(provider.type);
      warnings.push(
        `${field}.apiKey is not set; ${envName ? `export ${envName}` : 'set the key'} before starting the daemon (configured, not verified)`,
      );
    }
  };
  requiredEnv(stored.providers.main, 'providers.main');
  requiredEnv(stored.providers.medical, 'providers.medical');
  requiredEnv(stored.providers.embeddings, 'providers.embeddings');

  if (!stored.channels.telegram.enabled) {
    warnings.push('channels.telegram is disabled: no owner chat can pair, so the installation stays pairing-pending');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Project the persisted view out of an effective config. The three derived paths are dropped. */
export function toStoredView(config: EffectiveConfig): StoredConfig {
  const memory: StoredConfig['memory'] = {
    search: structuredClone(config.memory.search),
    bootstrapMaxChars: config.memory.bootstrapMaxChars,
    budgetRatios: structuredClone(config.memory.budgetRatios),
  };
  const heartbeat: StoredConfig['heartbeat'] = {
    enabled: config.heartbeat.enabled,
    timezone: config.heartbeat.timezone,
    policy: structuredClone(config.heartbeat.policy),
    recovery: structuredClone(config.heartbeat.recovery),
    retry: structuredClone(config.heartbeat.retry),
    rateLimit: structuredClone(config.heartbeat.rateLimit),
  };
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    providers: structuredClone(config.providers),
    channels: structuredClone(config.channels),
    tools: structuredClone(config.tools),
    memory,
    sessions: structuredClone(config.sessions),
    heartbeat,
    agent: structuredClone(config.agent),
    emergency: structuredClone(config.emergency),
    profiles: structuredClone(config.profiles),
  };
}

/** The documented `config set` protected-path policy. Returns `undefined` when the path is allowed. */
export function protectedSetReason(configPath: ConfigSetPath): string | undefined {
  const normalized = configPath.segments.join('.');
  const hit = PROTECTED_SET_PATHS.find(
    (entry) => normalized === entry.prefix || normalized.startsWith(`${entry.prefix}.`)
      || entry.prefix.startsWith(`${normalized}.`),
  );
  return hit?.reason;
}

const SECRET_KEYS = new Set(['apiKey', 'botToken']);

/** Replace secret-valued keys with a marker so local inspection output cannot leak them. */
export function redactConfig<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redactConfig(entry)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Plain = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = SECRET_KEYS.has(key) && typeof entry === 'string' && entry !== '' ? '[REDACTED]' : redactConfig(entry);
    }
    return out as T;
  }
  return value;
}
