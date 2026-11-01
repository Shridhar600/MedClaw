
import * as os from 'os';
import * as path from 'path';
import { getDefaultConfig, LOCAL_OLLAMA_BASE_URL, validateConfig, providerEnvVar } from '../config';
import type { EffectiveConfig, ProviderConfig } from '../config';
import { DirectoryLease, InstallationService } from '../runtime';
import type { SetupResult } from '../runtime';
import { OPENROUTER_DEFAULT_BASE_URL } from '../providers';
import { asProfileId, OWNER_ID_PATTERN, resolveOwnerPaths } from '../profiles';
import type { ProfileId } from '../profiles';
import type { SetupWizardState } from './wizard-types';

export interface ServiceOnboardingArgs {
  yes?: boolean;
  configPath?: string;
  stateRoot?: string;
  /** Owner identity. Validated by the same grammar the config decoder uses. */
  ownerId?: string;
  provider?: ProviderConfig['type'];
  mainModel?: string;
  medicalModel?: string;
  medicalProvider?: ProviderConfig['type'];
  /** Medical role only; never inherited from the main key. */
  medicalApiKey?: string;
  embeddingModel?: string;
  embeddingProvider?: ProviderConfig['type'];
  embeddingUrl?: string;
  embeddingApiKey?: string;
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
): providerType is 'ollama' | 'openai' | 'openrouter' {
  return SUPPORTED_ONBOARDING_PROVIDERS.includes(providerType);
}

export function requireOptionValue(token: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${token} requires a value. Usage: medclaw onboard ${token} <value>`);
  }
  if (value.trim() === '') {
    throw new Error(`${token} requires a non-empty value. Usage: medclaw onboard ${token} <value>`);
  }
  return value;
}

function parseProviderOption(
  token: '--provider' | '--medical-provider' | '--embedding-provider',
  value: string | undefined,
): ProviderConfig['type'] {
  const raw = requireOptionValue(token, value);
  if (!isSupportedOnboardingProvider(raw as ProviderConfig['type'])) {
    const subject: Record<typeof token, string> = {
      '--provider': 'onboard provider',
      '--medical-provider': 'onboard medical provider',
      '--embedding-provider': 'onboard embedding provider',
    };
    throw new Error(
      `Unsupported ${subject[token]}: ${token} accepts only`
      + ` ${SUPPORTED_ONBOARDING_PROVIDERS.join(', ')}.`,
    );
  }
  return raw as ProviderConfig['type'];
}

export function requireHttpEndpoint(token: string, raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (value === '') {
    throw new Error(`${token} requires a non-empty value. Usage: medclaw onboard ${token} <value>`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${token} must be an absolute http or https URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${token} must be an absolute http or https URL.`);
  }
  return value;
}

function parseEndpointOption(token: string, value: string | undefined): string {
  return requireHttpEndpoint(token, requireOptionValue(token, value));
}

function parseBoolean(token: string, value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  // Report the option name only; the supplied text may be a secret.
  throw new Error(`${token} requires one of: true, false, yes, no, on, off, 1, 0.`);
}

export function parseArgs(argv: string[]): ServiceOnboardingArgs {
  const args: ServiceOnboardingArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(
        `Unexpected argument at position ${index + 1}: setup takes options only.`
        + ' Run `medclaw onboard --help`.',
      );
    }
    const next = argv[index + 1];
    switch (token) {
      case '--yes':
        args.yes = true;
        break;
      case '--config':
        args.configPath = requireOptionValue('--config', next);
        index += 1;
        break;
      case '--state-root':
        args.stateRoot = requireOptionValue('--state-root', next);
        index += 1;
        break;
      case '--owner-id':
        args.ownerId = requireOptionValue('--owner-id', next);
        index += 1;
        break;
      case '--provider':
        args.provider = parseProviderOption('--provider', next);
        index += 1;
        break;
      case '--main-model':
        args.mainModel = requireOptionValue('--main-model', next);
        index += 1;
        break;
      case '--medical-model':
        args.medicalModel = requireOptionValue('--medical-model', next);
        index += 1;
        break;
      case '--medical-provider':
        args.medicalProvider = parseProviderOption('--medical-provider', next);
        index += 1;
        break;
      case '--medical-api-key':
        args.medicalApiKey = requireOptionValue('--medical-api-key', next);
        index += 1;
        break;
      case '--embedding-provider':
        args.embeddingProvider = parseProviderOption('--embedding-provider', next);
        index += 1;
        break;
      case '--embedding-model':
        args.embeddingModel = requireOptionValue('--embedding-model', next);
        index += 1;
        break;
      case '--embedding-url':
        args.embeddingUrl = parseEndpointOption('--embedding-url', next);
        index += 1;
        break;
      case '--embedding-api-key':
        args.embeddingApiKey = requireOptionValue('--embedding-api-key', next);
        index += 1;
        break;
      case '--ollama-url':
        args.ollamaUrl = parseEndpointOption('--ollama-url', next);
        index += 1;
        break;
      case '--api-key':
      case '--openai-api-key':
        args.apiKey = requireOptionValue('--api-key', next);
        index += 1;
        break;
      case '--telegram-token':
        args.telegramToken = requireOptionValue('--telegram-token', next);
        index += 1;
        break;
      case '--telegram-enabled':
        args.telegramEnabled = parseBoolean('--telegram-enabled', next);
        index += 1;
        break;
      case '--timezone':
        args.timezone = requireOptionValue('--timezone', next);
        index += 1;
        break;
      case '--heartbeats-enabled':
        args.heartbeatsEnabled = parseBoolean('--heartbeats-enabled', next);
        index += 1;
        break;
      default: {
        // Report only the option name. Everything after the first '=' is a value and may be a secret.
        const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
        throw new Error(
          `Unknown option: ${name}. Run \`medclaw onboard --help\` for the supported options.`,
        );
      }
    }
  }
  return args;
}

/** Usage text for the setup command. Kept beside the parser so the names cannot drift apart. */
export const ONBOARD_HELP_TEXT = [
  'Usage: medclaw onboard [options]',
  '',
  'Identity and target:',
  '  --config <path>          selected configuration document (also accepted globally, before `onboard`)',
  '  --state-root <dir>       owner state root (defaults to the config file directory)',
  '  --owner-id <id>          owner identity (default: default)',
  '  --yes                    run non-interactively without the wizard',
  '',
  'Main role:',
  '  --provider <ollama|openai|openrouter>',
  '  --main-model <model>',
  '  --api-key <secret>       explicit key for the MAIN role only',
  '  --ollama-url <url>       LOCAL role endpoint; never applied to a cloud main role',
  '',
  'Medical role (independent of main):',
  '  --medical-provider <ollama|openai|openrouter>',
  '  --medical-model <model>',
  '  --medical-api-key <secret>  explicit key for the MEDICAL role only',
  '',
  'Embedding role (independent of main; defaults to local Ollama):',
  '  --embedding-provider <ollama|openai|openrouter>',
  '  --embedding-model <model>',
  '  --embedding-url <http(s)-url>',
  '  --embedding-api-key <secret>',
  '',
  'Channels and preferences:',
  '  --telegram-enabled <true|false>',
  '  --telegram-token <secret>',
  '  --timezone <IANA zone>',
  '  --heartbeats-enabled <true|false>',
].join('\n') + '\n';

// Default on-device medical model, used whenever the medical provider resolves to Ollama.
function defaultMedgemmaModel(): string {
  return getDefaultConfig().providers.medical.model;
}

/** The default LOCAL endpoint for a local role. Resolved through the one config authority. */
function localOllamaUrl(): string {
  return getDefaultConfig().providers.main.baseUrl ?? LOCAL_OLLAMA_BASE_URL;
}

function buildProviderRole(options: {
  providerType: ProviderConfig['type'];
  model?: string;
  /** Explicit endpoint supplied for THIS role. */
  explicitBaseUrl?: string;
  /** The local-provider control (`--ollama-url`). Applies to local roles only. */
  ollamaUrl?: string;
  /** Explicit key for THIS role. If absent, the adapter uses only this provider's environment. */
  explicitApiKey?: string;
  /** Model default for this role's provider. */
  defaultModel: string;
  /** Whether this provider needs its router endpoint pinned. */
  pinsRouterEndpoint?: boolean;
  /** Chat-only hint. Embeddings deliberately ignore it. */
  reasoningEffort?: ProviderConfig['reasoningEffort'];
}): ProviderConfig {
  const {
    providerType, model, explicitBaseUrl, ollamaUrl,
    explicitApiKey, defaultModel, pinsRouterEndpoint, reasoningEffort,
  } = options;

  const role: ProviderConfig = {
    type: providerType,
    model: model ?? defaultModel,
  };

  // A blank endpoint means "not supplied", never "persist an empty string".
  const explicit = explicitBaseUrl?.trim() === '' ? undefined : explicitBaseUrl;

  if (providerType === 'ollama') {
    role.baseUrl = explicit ?? ollamaUrl ?? localOllamaUrl();
  } else if (explicit !== undefined) {
    role.baseUrl = explicit;
  } else if (pinsRouterEndpoint) {
    role.baseUrl = OPENROUTER_DEFAULT_BASE_URL;
  }

  const apiKey = explicitApiKey?.trim() ? explicitApiKey.trim() : undefined;
  if (apiKey !== undefined && providerType !== 'ollama') {
    role.apiKey = apiKey;
  }
  if (reasoningEffort !== undefined) {
    role.reasoningEffort = reasoningEffort;
  }
  return role;
}

/** Resolve the embedding role's selection, defaulting to the existing LOCAL Ollama default. */
export function resolveEmbeddingProvider(
  args: ServiceOnboardingArgs,
): ProviderConfig['type'] {
  return args.embeddingProvider ?? getDefaultConfig().providers.embeddings.type;
}

function applyProviders(
  config: EffectiveConfig,
  providerType: ProviderConfig['type'],
  args: ServiceOnboardingArgs,
): void {
  const mainDefaults = modelDefaultsForProvider(providerType);
  const embeddingType = resolveEmbeddingProvider(args);
  const embeddingDefaults = modelDefaultsForProvider(embeddingType);
  const apiKey = args.apiKey?.trim() ? args.apiKey.trim() : undefined;

  // OpenRouter has no SDK-default endpoint of its own; pin the selected role's router URL.
  config.providers.main = buildProviderRole({
    providerType,
    model: args.mainModel ?? mainDefaults.main,
    explicitBaseUrl: args.ollamaUrl && providerType === 'ollama' ? args.ollamaUrl : undefined,
    ollamaUrl: args.ollamaUrl,
    explicitApiKey: apiKey,
    defaultModel: mainDefaults.main,
    pinsRouterEndpoint: providerType === 'openrouter',
    reasoningEffort: providerType === 'openrouter' ? 'low' : undefined,
  });

  config.providers.embeddings = buildProviderRole({
    providerType: embeddingType,
    model: args.embeddingModel ?? embeddingDefaults.embeddings,
    explicitBaseUrl: args.embeddingUrl,
    ollamaUrl: args.ollamaUrl,
    explicitApiKey: args.embeddingApiKey,
    defaultModel: embeddingDefaults.embeddings,
    pinsRouterEndpoint: embeddingType === 'openrouter',
  });

  const medicalType = args.medicalProvider ?? 'ollama';
  config.providers.medical = buildProviderRole({
    providerType: medicalType,
    model: args.medicalModel,
    ollamaUrl: args.ollamaUrl,
    explicitApiKey: args.medicalApiKey,
    defaultModel: medicalType === 'ollama' ? defaultMedgemmaModel() : '',
    pinsRouterEndpoint: medicalType === 'openrouter',
  });
}

export function requiredCloudEnv(providerType: ProviderConfig['type']): string {
  return providerEnvVar(providerType) ?? '';
}

export function modelDefaultsForProvider(providerType: ProviderConfig['type']): {
  main: string;
  medical: string;
  embeddings: string;
} {
  // Medical defaults to on-device medgemma regardless of the main provider.
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

export function requireOwnerId(raw: string): ProfileId {
  const ownerId = asProfileId(raw.trim());
  if (ownerId === undefined) {
    throw new Error(
      `Invalid --owner-id: it must match /${OWNER_ID_PATTERN.source}/.`,
    );
  }
  return ownerId;
}

export function resolveNonInteractiveArgs(args: ServiceOnboardingArgs): ServiceOnboardingArgs {
  const defaults = getDefaultConfig();
  const values = resolveSetupValues(args);
  const providerDefaults = modelDefaultsForProvider(values.providerType);
  // The embedding role resolves from its own selection and its own provider defaults.
  const embeddingType = resolveEmbeddingProvider(args);
  const embeddingDefaults = modelDefaultsForProvider(embeddingType);

  return {
    ...args,
    configPath: values.configPath,
    stateRoot: values.stateRoot,
    ownerId: values.ownerId,
    provider: values.providerType,
    mainModel: args.mainModel ?? providerDefaults.main,
    // A cloud medical model is an explicit user choice, not the local MedGemma default.
    medicalModel: args.medicalModel ?? ((args.medicalProvider ?? 'ollama') === 'ollama' ? providerDefaults.medical : ''),
    medicalApiKey: args.medicalApiKey?.trim() ? args.medicalApiKey.trim() : undefined,
    embeddingProvider: embeddingType,
    embeddingModel: args.embeddingModel ?? embeddingDefaults.embeddings,
    embeddingUrl: args.embeddingUrl,
    embeddingApiKey: args.embeddingApiKey?.trim() ? args.embeddingApiKey.trim() : undefined,
    ollamaUrl:
      args.ollamaUrl ?? (values.providerType === 'ollama' ? defaults.providers.main.baseUrl ?? '' : undefined),
    apiKey: args.apiKey?.trim() ? args.apiKey.trim() : undefined,
    telegramToken: values.telegramToken,
    telegramEnabled: args.telegramEnabled ?? defaults.channels.telegram.enabled,
    timezone: args.timezone ?? defaults.heartbeat.timezone,
    heartbeatsEnabled: args.heartbeatsEnabled ?? defaults.heartbeat.enabled,
  };
}

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

  applyProviders(config, values.providerType, args);

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
    medicalProvider: resolved.medicalProvider ?? 'ollama',
    medicalApiKey: resolved.medicalApiKey,
    // Seeded from the embedding role's own selection, defaulting to the local Ollama role.
    embeddingProvider:
      resolved.embeddingProvider && isSupportedOnboardingProvider(resolved.embeddingProvider)
        ? resolved.embeddingProvider
        : defaults.providers.embeddings.type,
    embeddingModel: resolved.embeddingModel ?? defaults.providers.embeddings.model,
    embeddingUrl: resolved.embeddingUrl,
    embeddingApiKey: resolved.embeddingApiKey,
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

  if ((args.medicalProvider ?? 'ollama') !== 'ollama' && !config.providers.medical.model.trim()) {
    errors.push('--medical-model is required for a cloud medical provider. Select a model supported by that provider.');
  }

  const embeddingType = resolveEmbeddingProvider(args);
  const requiredCloudRoles: Array<{ label: string; type: ProviderConfig['type']; explicitKey?: string; flag: string }> = [
    { label: 'provider', type: values.providerType, explicitKey: args.apiKey, flag: 'api-key' },
    { label: 'embedding provider', type: embeddingType, explicitKey: args.embeddingApiKey, flag: 'embedding-api-key' },
    { label: 'medical provider', type: args.medicalProvider ?? 'ollama', explicitKey: args.medicalApiKey, flag: 'medical-api-key' },
  ];
  for (const role of requiredCloudRoles) {
    if (role.type === 'ollama') continue;
    if (role.explicitKey?.trim()) continue;
    if (process.env[requiredCloudEnv(role.type)]?.trim()) continue;
    errors.push(
      `${requiredCloudEnv(role.type)} or --${role.flag}`
      + ` is required for ${role.label} ${isSupportedOnboardingProvider(role.type) ? role.type : '(unsupported)'}.`,
    );
  }

  if (config.channels.telegram.enabled && !values.telegramToken.trim()) {
    errors.push('telegram is enabled but no bot token was provided.');
  }

  const validation = validateConfig(config);
  errors.push(...validation.errors);
  return errors;
}

export async function persistSetupArtifacts(configPath: string, config: EffectiveConfig): Promise<void> {
  const ownerId = asProfileId(config.profiles.defaultProfileId);
  if (ownerId === undefined) {
    throw new Error(
      'Setup refused: profiles.defaultProfileId is not a valid owner ID, so no owner record could be created.',
    );
  }

  const outcome = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });

  if (outcome.kind === 'committed') return;
  throw new Error(describeSetupRefusal(outcome));
}

/** Refusal text for a setup result, safe to show in local CLI output. */
function describeSetupRefusal(outcome: SetupResult): string {
  switch (outcome.kind) {
    case 'busy':
      return `Setup refused: ${outcome.lease.guidance}`;
    case 'unavailable':
      return `Setup refused: ${outcome.guidance}`;
    case 'not-fresh':
    case 'incomplete':
      return outcome.message;
    default:
      return 'Setup refused: the installation was not committed.';
  }
}
