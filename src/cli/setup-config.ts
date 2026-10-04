// src/cli/setup-config.ts
//
// Setup's argument parsing and configuration/artifact building, extracted so the wizard and the
// service entry point stop importing each other (plan 15 §2.4). `service-onboarding.ts` no longer
// needs a dynamic import of the wizard, and `setup-wizard.ts` no longer imports the service —
// the grandfathered cycle in `.dependency-cruiser.cjs` can go away.
//
// Identity is chosen HERE and nowhere else. The state root defaults to the selected config file's
// directory, the owner ID defaults to `default`, and every owner path is DERIVED from that pair.
// `--workspace` and `--force` are retired rather than silently reinterpreted: an old invocation
// gets an explicit message instead of writing somewhere it did not mean to.
//
// This module does no prompting and no daemon launch. Those stay in the wizard and the service
// entry.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDefaultConfig } from '../config/config';
import { toStoredView, validateConfig } from '../config/validation';
import { writeConfigDocument } from '../runtime';
import { providerEnvVar } from '../config/provider-env';
import type { EffectiveConfig, ProviderConfig } from '../config/types';
import { OPENROUTER_DEFAULT_BASE_URL } from '../providers/openai';
import { asProfileId, resolveOwnerPaths } from '../profiles';
import type { ProfileId } from '../profiles';
import type { SetupWizardState } from './wizard-types';
import { ensureWorkspaceTemplates } from './prompts';
import { secureMkdir } from '../security';

export interface ServiceOnboardingArgs {
  yes?: boolean;
  configPath?: string;
  /**
   * Owner state root. Every owner path is derived from it, so there is no second path authority.
   * Defaults to the selected config file's directory.
   */
  stateRoot?: string;
  /** Owner identity. Validated by the same grammar the config decoder uses. */
  ownerId?: string;
  provider?: ProviderConfig['type'];
  mainModel?: string;
  medicalModel?: string;
  // forka #11: the medical model resolves INDEPENDENTLY of the main provider and
  // defaults to on-device Ollama medgemma (privacy + health-specialized). Set
  // --medical-provider to opt into a cloud medical model.
  medicalProvider?: ProviderConfig['type'];
  embeddingModel?: string;
  ollamaUrl?: string;
  apiKey?: string;
  telegramToken?: string;
  telegramEnabled?: boolean;
  timezone?: string;
  heartbeatsEnabled?: boolean;
}

export interface ResolvedSetupValues {
  configPath: string;
  /** Absolute, canonical state root every owner path is derived from. */
  stateRoot: string;
  ownerId: ProfileId;
  /** DERIVED display value. Never an independent input. */
  workspacePath: string;
  telegramToken: string;
  providerType: ProviderConfig['type'];
}

/** The identity local setup chooses when `--owner-id` is not supplied. */
export const DEFAULT_SETUP_OWNER_ID = 'default';

export const SUPPORTED_ONBOARDING_PROVIDERS: readonly ProviderConfig['type'][] = [
  'ollama',
  'openai',
  'openrouter',
];

export function isSupportedOnboardingProvider(
  providerType: ProviderConfig['type'],
): providerType is 'ollama' | 'openai' {
  return SUPPORTED_ONBOARDING_PROVIDERS.includes(providerType);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

export function parseArgs(argv: string[]): ServiceOnboardingArgs {
  const args: ServiceOnboardingArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const next = argv[index + 1];
    switch (token) {
      case '--yes':
        args.yes = true;
        break;
      case '--config':
        args.configPath = next;
        index += 1;
        break;
      case '--state-root':
        args.stateRoot = next;
        index += 1;
        break;
      case '--owner-id':
        args.ownerId = next;
        index += 1;
        break;
      // Retired on purpose (plan 15 §2.4). An old invocation is refused with guidance rather than
      // silently reinterpreted as the new scoped layout.
      case '--workspace':
        throw new Error(
          '--workspace is retired. The owner workspace is now DERIVED from the state root; '
          + 'choose one with --state-root <dir> (or --config <file>, whose directory becomes the state root).',
        );
      case '--force':
        throw new Error(
          '--force is retired. Setup refuses to overwrite an existing installation; '
          + 'choose a fresh --state-root / --config target instead. Existing credentials and evidence are never removed.',
        );
      case '--provider':
        args.provider = next as ProviderConfig['type'];
        index += 1;
        break;
      case '--main-model':
        args.mainModel = next;
        index += 1;
        break;
      case '--medical-model':
        args.medicalModel = next;
        index += 1;
        break;
      case '--medical-provider':
        args.medicalProvider = next as ProviderConfig['type'];
        index += 1;
        break;
      case '--embedding-model':
        args.embeddingModel = next;
        index += 1;
        break;
      case '--ollama-url':
        args.ollamaUrl = next;
        index += 1;
        break;
      case '--api-key':
      case '--openai-api-key':
        args.apiKey = next;
        index += 1;
        break;
      case '--telegram-token':
        args.telegramToken = next;
        index += 1;
        break;
      case '--telegram-enabled':
        args.telegramEnabled = parseBoolean(next);
        index += 1;
        break;
      case '--timezone':
        args.timezone = next;
        index += 1;
        break;
      case '--heartbeats-enabled':
        args.heartbeatsEnabled = parseBoolean(next);
        index += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

function ensureParent(filePath: string): void {
  secureMkdir(path.dirname(filePath));
}

/**
 * Refuse any pre-existing installation state. This replaces `--force`: there is no overwrite, no
 * resume and no unsolicited wipe. A stale credential file or an existing piece of owner evidence is
 * left exactly where it is.
 */
export function assertFreshInstallation(configPath: string, ownerRecordPath: string, workspace: string): void {
  if (fs.existsSync(configPath)) {
    throw new Error(
      `Setup refused: a configuration already exists at ${configPath}. `
      + 'Setup never overwrites an installation. Choose a fresh --config and/or --state-root target.',
    );
  }
  if (fs.existsSync(ownerRecordPath)) {
    throw new Error(
      `Setup refused: an owner record already exists at ${ownerRecordPath}. `
      + 'Setup never overwrites an installation. Choose a fresh --state-root target.',
    );
  }
  if (directoryHasEntries(workspace)) {
    throw new Error(
      `Setup refused: the owner workspace ${workspace} is not empty. `
      + 'Existing owner evidence is never removed. Choose a fresh --state-root target.',
    );
  }
}

function directoryHasEntries(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Create the unpaired owner record. `initialize()` is a no-op when one already exists, and refuses
 * when the existing record is unreadable — setup must not overwrite or repair an existing record.
 */
async function initializeOwnerRecord(ownerRecordPath: string, ownerId: ProfileId): Promise<void> {
  const { FileOwnerStatePort } = await import('../runtime/adapters/owner-state-file');
  const { CryptoPairingCodePort } = await import('../runtime/adapters/pairing-code');
  const { OwnerAdmissionService } = await import('../profiles');
  const { systemClock } = await import('../ports/defaults');

  const service = new OwnerAdmissionService({
    store: new FileOwnerStatePort(ownerRecordPath, ownerId),
    codes: new CryptoPairingCodePort(),
    clock: systemClock,
    expectedOwnerId: ownerId,
  });
  const outcome = await service.initialize();
  if (outcome !== 'created') {
    throw new Error(
      `Setup refused: the owner record at ${ownerRecordPath} already exists (${outcome}). `
      + 'Setup never overwrites or repairs an existing installation. Choose a fresh --state-root target.',
    );
  }
}

// forka #11: the default on-device medical model + Ollama URL, used whenever the
// medical provider resolves to Ollama (which is the default, independent of the
// main provider).
const ONDEVICE_OLLAMA_URL = 'http://localhost:11434/v1';
function defaultMedgemmaModel(): string {
  return getDefaultConfig().providers.medical.model;
}

function applyProvider(
  config: EffectiveConfig,
  providerType: ProviderConfig['type'],
  args: ServiceOnboardingArgs,
): void {
  const ollamaUrl = args.ollamaUrl ?? config.providers.main.baseUrl ?? ONDEVICE_OLLAMA_URL;
  const apiKey = args.apiKey?.trim() ? args.apiKey.trim() : undefined;

  // Main + embeddings follow the chosen provider.
  if (providerType === 'ollama') {
    config.providers.main = {
      type: 'ollama',
      model: args.mainModel ?? config.providers.main.model,
      baseUrl: ollamaUrl,
    };
    config.providers.embeddings = {
      type: 'ollama',
      model: args.embeddingModel ?? config.providers.embeddings.model,
      baseUrl: ollamaUrl,
    };
  } else {
    const cloudDefaults = modelDefaultsForProvider(providerType);
    const isRouter = providerType === 'openrouter';
    config.providers.main = {
      type: providerType,
      model: args.mainModel ?? cloudDefaults.main,
      // OpenRouter has no SDK-default endpoint of its own — pin its router URL.
      ...(isRouter ? { baseUrl: OPENROUTER_DEFAULT_BASE_URL, reasoningEffort: 'low' as const } : {}),
      ...(args.ollamaUrl ? { baseUrl: args.ollamaUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
    config.providers.embeddings = {
      type: providerType,
      model: args.embeddingModel ?? cloudDefaults.embeddings,
      ...(isRouter ? { baseUrl: OPENROUTER_DEFAULT_BASE_URL } : {}),
      ...(args.ollamaUrl ? { baseUrl: args.ollamaUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }

  // forka #11: medical resolves INDEPENDENTLY of the main provider and defaults
  // to on-device Ollama medgemma — the health-specialized model, kept local for
  // the core privacy promise. Opt out with --medical-provider (+ --medical-model).
  const medicalType = args.medicalProvider ?? 'ollama';
  if (medicalType === 'ollama') {
    config.providers.medical = {
      type: 'ollama',
      model: args.medicalModel ?? defaultMedgemmaModel(),
      baseUrl: args.ollamaUrl ?? ONDEVICE_OLLAMA_URL,
    };
  } else {
    config.providers.medical = {
      type: medicalType,
      model: args.medicalModel ?? 'gpt-4o-mini',
      ...(args.ollamaUrl ? { baseUrl: args.ollamaUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }
}

export function requiredCloudEnv(providerType: ProviderConfig['type']): string {
  return providerEnvVar(providerType) ?? '';
}

export function modelDefaultsForProvider(providerType: ProviderConfig['type']): {
  main: string;
  medical: string;
  embeddings: string;
} {
  // forka #11: medical defaults to on-device medgemma independent of the main
  // provider, so it is the same for cloud and Ollama here.
  const medical = getDefaultConfig().providers.medical.model;
  if (providerType === 'openrouter') {
    return {
      main: 'stealth/ox-alpha',
      medical,
      embeddings: 'openai/text-embedding-3-small',
    };
  }
  if (providerType === 'openai' || providerType === 'anthropic' || providerType === 'google') {
    return {
      main: 'gpt-4o-mini',
      medical,
      embeddings: 'text-embedding-3-small',
    };
  }

  const defaults = getDefaultConfig();
  return {
    main: defaults.providers.main.model,
    medical,
    embeddings: defaults.providers.embeddings.model,
  };
}

export function providerLabel(providerType: ProviderConfig['type']): string {
  switch (providerType) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'google':
      return 'Google';
    case 'openrouter':
      return 'OpenRouter';
    case 'ollama':
      return 'Ollama';
  }
}

export function resolveSetupPath(input: string): string {
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

export function defaultConfigPath(): string {
  return resolveSetupPath(path.join(process.env.HOME ?? os.homedir(), '.redacted', 'config.json'));
}

export function resolveSetupValues(args: ServiceOnboardingArgs): ResolvedSetupValues {
  const defaults = getDefaultConfig();
  const configPath = resolveSetupPath(args.configPath ?? defaultConfigPath());
  const stateRoot = resolveSetupPath(args.stateRoot ?? path.dirname(configPath));
  const ownerId = requireOwnerId(args.ownerId ?? DEFAULT_SETUP_OWNER_ID);
  return {
    configPath,
    stateRoot,
    ownerId,
    workspacePath: resolveOwnerPaths(stateRoot, ownerId).workspace,
    telegramToken: args.telegramToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '',
    providerType: args.provider ?? defaults.providers.main.type,
  };
}

/**
 * Validate an owner ID with the same grammar the config decoder uses, so setup cannot write an
 * identity that would later be refused.
 */
export function requireOwnerId(raw: string): ProfileId {
  const ownerId = asProfileId(raw.trim());
  if (ownerId === undefined) {
    throw new Error(
      `Invalid --owner-id: ${JSON.stringify(raw)}. It must match /^[a-z0-9][a-z0-9-]{0,63}$/.`,
    );
  }
  return ownerId;
}

export function resolveNonInteractiveArgs(args: ServiceOnboardingArgs): ServiceOnboardingArgs {
  const defaults = getDefaultConfig();
  const values = resolveSetupValues(args);
  const providerDefaults = modelDefaultsForProvider(values.providerType);

  return {
    ...args,
    configPath: values.configPath,
    stateRoot: values.stateRoot,
    ownerId: values.ownerId,
    provider: values.providerType,
    mainModel: args.mainModel ?? providerDefaults.main,
    medicalModel: args.medicalModel ?? providerDefaults.medical,
    embeddingModel: args.embeddingModel ?? providerDefaults.embeddings,
    ollamaUrl:
      args.ollamaUrl ?? (values.providerType === 'ollama' ? defaults.providers.main.baseUrl ?? '' : undefined),
    apiKey: args.apiKey?.trim() ? args.apiKey.trim() : undefined,
    telegramToken: values.telegramToken,
    telegramEnabled: args.telegramEnabled ?? defaults.channels.telegram.enabled,
    timezone: args.timezone ?? defaults.heartbeat.timezone,
    heartbeatsEnabled: args.heartbeatsEnabled ?? defaults.heartbeat.enabled,
  };
}

/**
 * Select the owner identity and derive every owner path from it.
 *
 * Setup is the only place identity is chosen. The state root is the selected config file's
 * directory, and the owner workspace, scheduler store and audit log are derived from it, so
 * the document has one path authority and setup can never inherit the operator's real home
 * directory. T3 replaces this with the lease-owned `InstallationService.setup()` and adds the
 * explicit `--state-root` / `--owner-id` selection; the derivation itself does not change.
 */
export function buildConfigFromArgs(inputArgs: ServiceOnboardingArgs): EffectiveConfig {
  const args = resolveNonInteractiveArgs(inputArgs);
  const defaults = getDefaultConfig();
  const values = resolveSetupValues(args);
  const config = getDefaultConfig();

  const { stateRoot, ownerId } = values;
  const ownerPaths = resolveOwnerPaths(stateRoot, ownerId);
  config.profiles = { baseDir: stateRoot, defaultProfileId: ownerId };
  config.memory.workspace = ownerPaths.workspace;
  config.heartbeat.storePath = ownerPaths.schedulerStore;
  config.heartbeat.audit.path = ownerPaths.auditLog;
  config.heartbeat.timezone = args.timezone ?? defaults.heartbeat.timezone;
  config.heartbeat.enabled = args.heartbeatsEnabled ?? defaults.heartbeat.enabled;
  config.channels.telegram.enabled = args.telegramEnabled ?? defaults.channels.telegram.enabled;
  config.channels.telegram.botToken = config.channels.telegram.enabled ? values.telegramToken : '';

  applyProvider(config, values.providerType, args);

  return config;
}

export function createInitialWizardState(args: ServiceOnboardingArgs): SetupWizardState {
  const defaults = getDefaultConfig();
  const resolved = resolveNonInteractiveArgs(args);
  const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    configPath: resolved.configPath ?? defaultConfigPath(),
    stateRoot: resolved.stateRoot ?? resolveSetupPath(path.dirname(resolved.configPath ?? defaultConfigPath())),
    ownerId: resolved.ownerId ?? (asProfileId(DEFAULT_SETUP_OWNER_ID) as ProfileId),
    provider:
      resolved.provider && isSupportedOnboardingProvider(resolved.provider)
        ? resolved.provider
        : defaults.providers.main.type,
    mainModel: resolved.mainModel ?? defaults.providers.main.model,
    medicalModel: resolved.medicalModel ?? defaults.providers.medical.model,
    embeddingModel: resolved.embeddingModel ?? defaults.providers.embeddings.model,
    ollamaUrl: resolved.ollamaUrl,
    apiKey: resolved.apiKey,
    telegramEnabled: args.telegramEnabled ?? false,
    telegramToken: resolved.telegramToken,
    timezone: args.timezone ?? systemTimezone ?? defaults.heartbeat.timezone,
    heartbeatsEnabled: args.heartbeatsEnabled ?? false,
  };
}

export function collectSetupErrors(args: ServiceOnboardingArgs, config: EffectiveConfig): string[] {
  const values = resolveSetupValues(args);
  const errors: string[] = [];

  if (
    values.providerType !== 'ollama' &&
    !args.apiKey?.trim() &&
    !process.env[requiredCloudEnv(values.providerType)]?.trim()
  ) {
    errors.push(`${requiredCloudEnv(values.providerType)} or --api-key is required for provider ${values.providerType}.`);
  }

  if (config.channels.telegram.enabled && !values.telegramToken.trim()) {
    errors.push('telegram is enabled but no bot token was provided.');
  }

  const validation = validateConfig(config);
  errors.push(...validation.errors);
  return errors;
}

/**
 * Write the scoped workspace, then the configuration document last.
 *
 * The persisted form is the STORED document: derived owner paths are never written, so
 * there is no second path authority. T3 replaces this sequence with the lease-owned
 * `InstallationService.setup()` that also creates the unpaired owner record.
 */
export async function persistSetupArtifacts(configPath: string, config: EffectiveConfig): Promise<void> {
  const ownerId = asProfileId(config.profiles.defaultProfileId) as ProfileId;
  const ownerPaths = resolveOwnerPaths(config.profiles.baseDir, ownerId);

  // Setup is additive only. An existing installation, record or non-empty owner workspace is
  // refused with guidance; nothing is overwritten, resumed or wiped on the owner's behalf.
  assertFreshInstallation(configPath, ownerPaths.ownerRecord, ownerPaths.workspace);

  ensureWorkspaceTemplates(config.memory.workspace);
  ensureParent(configPath);
  // The scheduler store and audit log are derived inside the owner's state directory, so setup
  // creates that directory rather than a sibling `heartbeats/` tree beside the config.
  secureMkdir(path.dirname(config.heartbeat.storePath));

  // The unpaired owner record is created BEFORE the configuration document, so a document that
  // exists always has a record behind it and a record never exists without one.
  await initializeOwnerRecord(ownerPaths.ownerRecord, ownerId);

  const outcome = writeConfigDocument(configPath, toStoredView(config));
  if (outcome.status === 'failed') {
    throw new Error(
      'Setup could not write the configuration document; the workspace was created but setup is incomplete. Re-run setup into a fresh target.',
    );
  }
  if (outcome.status === 'uncertain') {
    throw new Error(
      'Setup wrote the configuration document but could not confirm its durability. Setup is incomplete; inspect the file before re-running setup.',
    );
  }
}
