
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_SCHEMA_VERSION, type StoredConfig } from '../../src/config/types';
import { cloneStoredDefaults } from '../../src/config/defaults';
import { writeConfigDocument } from '../../src/runtime/installation';

export interface ConfigFixture {
  configPath: string;
  baseDir: string;
  ownerId: string;
  workspace: string;
  storePath: string;
  auditLogPath: string;
  searchDb: string;
  sessions: string;
  workspaceLease: string;
  ownerRecord: string;
  mediaStaging: string;
}

/** A valid stored document for `baseDir`/`ownerId`, with optional deep overrides. */
export function storedConfigFor(baseDir: string, ownerId: string): StoredConfig {
  const stored = cloneStoredDefaults();
  stored.profiles = { baseDir, defaultProfileId: ownerId };
  return stored;
}

/** Write a valid document and return the resolved owner paths a test should assert on. */
export function writeConfigFixture(
  rootDir: string,
  overrides: {
    ownerId?: string;
    baseDir?: string;
    telegramEnabled?: boolean;
    telegramToken?: string;
    providerType?: 'ollama' | 'openai';
    apply?: (stored: StoredConfig) => void;
    /** Write an arbitrary raw string instead of a valid document (for refusal tests). */
    raw?: string;
  } = {},
): ConfigFixture {
  const baseDir = overrides.baseDir ?? path.join(rootDir, 'state');
  const ownerId = overrides.ownerId ?? 'owner';
  const configPath = path.join(rootDir, 'config.json');
  fs.mkdirSync(rootDir, { recursive: true });

  if (overrides.raw !== undefined) {
    fs.writeFileSync(configPath, overrides.raw);
  } else {
    const stored = storedConfigFor(baseDir, ownerId);
    stored.channels.telegram.enabled = overrides.telegramEnabled ?? false;
    stored.channels.telegram.botToken = overrides.telegramEnabled ? (overrides.telegramToken ?? '123:fixture-token') : '';
    if (overrides.providerType) {
      stored.providers.main.type = overrides.providerType;
      if (overrides.providerType === 'openai') {
        delete stored.providers.main.baseUrl;
        stored.providers.main.apiKey = 'sk-fixture-key';
        stored.providers.main.model = 'gpt-4o';
      }
    }
    overrides.apply?.(stored);
    const outcome = writeConfigDocument(configPath, stored);
    if (outcome.status !== 'committed') {
      throw new Error(`fixture write did not commit: ${outcome.status}`);
    }
  }

  const workspace = path.join(baseDir, 'profiles', ownerId);
  const stateDir = path.join(workspace, '.state');
  return {
    configPath,
    baseDir,
    ownerId,
    workspace,
    storePath: path.join(stateDir, 'heartbeat-jobs.json'),
    auditLogPath: path.join(stateDir, 'audit.jsonl'),
    searchDb: path.join(stateDir, 'search.db'),
    sessions: path.join(stateDir, 'sessions'),
    workspaceLease: path.join(stateDir, 'installation.lease'),
    ownerRecord: path.join(stateDir, 'owner-access.json'),
    mediaStaging: path.join(stateDir, 'media-staging'),
  };
}

export { CONFIG_SCHEMA_VERSION };
