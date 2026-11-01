// src/cli/setup-config.ts
//
// Setup's argument parsing and configuration/artifact building, extracted so the wizard and the
// service entry point stop importing each other (plan 15 §2.4). `service-onboarding.ts` no longer
// needs a dynamic import of the wizard, and `setup-wizard.ts` no longer imports the service —
// the grandfathered cycle in `.dependency-cruiser.cjs` can go away.
//
// Identity is chosen HERE and nowhere else. The state root defaults to the selected config file's
// directory, the owner ID defaults to `default`, and every owner path is DERIVED from that pair.
//
// This module does no prompting and no daemon launch. Those stay in the wizard and the service
// entry.

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
  /** Medical role only; never inherited from the main key. */
  medicalApiKey?: string;
  // R05 (plan 15 §2.4): embeddings are an INDEPENDENT selection. Defaults stay local Ollama even
  // when main is cloud; an explicit embedding provider/model/url/key overrides only this role.
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

/**
 * A required option value.
 *
 * Refuses a missing value, an empty/blank value, and a value that is itself an option — the three
 * ways `--config --yes` or a trailing `--config` used to be accepted as a value. The FIELD NAME is
 * reported, never the supplied text, because the value may be a secret (brief §8C).
 *
 * Exported so the setup ENTRY point applies the same rule to the config pair it forwards, instead of
 * growing its own weaker check (C04-P02). One policy, one implementation.
 */
export function requireOptionValue(token: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${token} requires a value. Usage: medclaw onboard ${token} <value>`);
  }
  if (value.trim() === '') {
    throw new Error(`${token} requires a non-empty value. Usage: medclaw onboard ${token} <value>`);
  }
  return value;
}

/**
 * An explicit provider selection must name a supported provider, at parse time.
 *
 * The refusal names the ROLE and the option that must change, and lists the supported choices. It
 * never repeats the supplied value: a pasted key is a realistic `--provider` value, and printing it
 * back writes a secret into the terminal and into any captured log (C04-P01).
 *
 * The message PREFIX for each role is unchanged from the pre-existing refusal, so the assertions
 * already pinned to `Unsupported onboard provider` / `… medical provider` / `… embedding provider`
 * keep holding; only the value interpolation is gone.
 */
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

/**
 * An explicit endpoint must be an absolute http(s) URL.
 *
 * Exported because the wizard asks for the same endpoint interactively and must apply the SAME
 * rule — a second copy of this check in the wizard would be a second policy for the same contract.
 * Returns the accepted value, or throws a message naming only the option.
 */
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
  // Reports the option name only. The old message interpolated the supplied text, which is a
  // secret-bearing path for `--telegram-enabled`-adjacent usage and violates the no-values rule.
  throw new Error(`${token} requires one of: true, false, yes, no, on, off, 1, 0.`);
}

/**
 * STRICT setup argument parsing.
 *
 * Every rejection here happens before the wizard, before any lease, directory, template, record or
 * config write (brief §8C):
 *  - an unknown option is refused instead of silently ignored (R06 / SOL-05);
 *  - an unexpected bare token is refused;
 *  - a missing, blank, or option-shaped value is refused, so a trailing `--config` can no longer
 *    erase the globally selected target and silently fall back to the home default;
 *  - a required value that is itself an option (`--config --yes`) is refused;
 *  - explicit provider, boolean and URL values are validated here, not at first use.
 *
 * Errors name the FIELD or the reason only. A supplied value is never echoed, because
 * `--api-key`, `--medical-api-key`, `--embedding-api-key` and `--telegram-token` are secret-bearing options.
 */
export function parseArgs(argv: string[]): ServiceOnboardingArgs {
  const args: ServiceOnboardingArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('--')) {
      // Names the POSITION, never the text. An operator who forgets `--api-key` and pastes the key
      // as a positional argument would otherwise have the secret written to stderr and into any
      // captured log. (Cold-review finding 2 — this branch previously echoed the token verbatim.)
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
        // Report only the option NAME. An operator who wrote `--api-key=sk-...` must not have the
        // secret echoed back: everything after the first '=' is a value. (Cold re-review D1.)
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

// forka #11: the default on-device medical model + Ollama URL, used whenever the
// medical provider resolves to Ollama (which is the default, independent of the
// main provider).
function defaultMedgemmaModel(): string {
  return getDefaultConfig().providers.medical.model;
}

/** The default LOCAL endpoint for a local role. Resolved through the one config authority. */
function localOllamaUrl(): string {
  return getDefaultConfig().providers.main.baseUrl ?? LOCAL_OLLAMA_BASE_URL;
}

/**
 * Build ONE provider role from its own explicit inputs.
 *
 * R05 replaced a single `applyProvider` that wrote main and embeddings together, which is what made
 * cloud main silently move embeddings to cloud and copied `--api-key` into every role. Each role is
 * now resolved from its own provider/model/endpoint/key, so nothing can leak sideways between them.
 *
 * Endpoint precedence, per role:
 *  - an explicit role endpoint wins;
 *  - otherwise a local role uses `--ollama-url` (or the local default) and a cloud role uses its
 *    own provider default — never the local fallback, never another role's endpoint.
 */
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

  // A blank endpoint means "not supplied", never "persist an empty string". The interactive wizard
  // can produce one (an operator pressing Enter at the endpoint prompt), and persisting `""` wrote a
  // meaningless field the decoder then dropped on reload.
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

/**
 * Apply all three roles independently (plan 15 §2.4: "Main provider and embeddings are independent
 * choices").
 *
 * Main keeps its existing defaults. Embeddings default to the local Ollama default even when main
 * is cloud — that default is the R05 fix, not an omission. Medical stays on-device medgemma by
 * default, independently of main (forka #11).
 */
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

  // forka #11: medical resolves INDEPENDENTLY of the main provider and defaults
  // to on-device Ollama medgemma — the health-specialized model, kept local for
  // the core privacy promise. Opt out with --medical-provider (+ --medical-model).
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
 *
 * The refusal names the option and the grammar it must satisfy, never the supplied text. An
 * operator who pastes a credential instead of an id would otherwise have it printed back to the
 * terminal and into any captured log (C04-P01).
 */
export function requireOwnerId(raw: string): ProfileId {
  const ownerId = asProfileId(raw.trim());
  if (ownerId === undefined) {
    // The grammar is rendered from the one authority the decoder uses, wrapped in slashes so the
    // operator recognizes it as the regular expression it is.
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
  // R05: the embedding role resolves from its OWN selection and its OWN provider defaults. It used
  // to take `providerDefaults.embeddings` — the MAIN provider's cloud defaults — which is what made
  // cloud main silently move embeddings to cloud.
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
    // An explicit embedding endpoint survives resolution untouched. `--ollama-url` stays the LOCAL
    // control and is applied inside `buildProviderRole`, never here, so a cloud embedding role can
    // never inherit it.
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
    // R05: seeded from the EMBEDDING role's own selection, defaulting to the local Ollama role.
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

  // Per-role credential requirement. Each CLOUD role is satisfied by ITS OWN explicit key or ITS
  // OWN provider's environment variable — never by the other role's explicit key.
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

/**
 * Commit a new installation by calling the lease-owning writer.
 *
 * This function used to do the work itself: an `assertFreshInstallation` CHECK, then templates, then
 * the owner record, then the config document — all holding **no lease at all**. Nothing stopped that
 * from committing a second installation beside a running daemon (which holds both leases), or from
 * letting two concurrent setups both pass the check. The locked rule in plan 15 §2.2 is that
 * "short-lived setup/config/pairing writers hold both until their commit/refusal completes", so the
 * sequence now lives in `InstallationService.setup()`, which acquires the config lease, then the
 * owner workspace lease, decides freshness UNDER BOTH, and releases only what it acquired.
 *
 * Kept as a function because both callers need it: the service entry and the wizard's retry loop.
 * It stays a thin adapter — CLI in, CLI error text out — so no writer logic is reintroduced here.
 */
export async function persistSetupArtifacts(configPath: string, config: EffectiveConfig): Promise<void> {
  const ownerId = asProfileId(config.profiles.defaultProfileId);
  if (ownerId === undefined) {
    throw new Error(
      'Setup refused: profiles.defaultProfileId is not a valid owner ID, so no owner record could be created.',
    );
  }

  const outcome = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });

  if (outcome.kind === 'committed') return;
  // Every non-commit result is a refusal with operator-facing guidance already attached. Throwing
  // keeps both existing callers unchanged: the service entry prints it, and the wizard's retry loop
  // catches it, reports it and lets the operator adjust the target.
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
      // Unreachable: the caller returns on `committed` before reaching here. Stated rather than
      // left implicit so a future variant cannot silently report a success as a refusal.
      return 'Setup refused: the installation was not committed.';
  }
}
