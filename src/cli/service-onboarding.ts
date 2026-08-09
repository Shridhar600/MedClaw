import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type SpawnOptions } from 'child_process';
import { getDefaultConfig, loadConfig, saveConfig } from '../config/config';
import { validateConfig } from '../config/validation';
import { providerEnvVar } from '../config/provider-env';
import type { AppConfig, ProviderConfig } from '../config/types';
import { showConfig, showRedactedConfigSummary } from './admin';
import { ensureWorkspaceTemplates, type CliIO } from './prompts';
import { preflightStartCheck, type SetupReadinessDependencies } from './setup-readiness';
import type { CompletionAction, SetupWizardState } from './wizard-types';
import { secureMkdir } from '../security';

export interface ServiceOnboardingArgs {
  yes?: boolean;
  force?: boolean;
  configPath?: string;
  workspace?: string;
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
  workspacePath: string;
  telegramToken: string;
  providerType: ProviderConfig['type'];
}

export const SUPPORTED_ONBOARDING_PROVIDERS: readonly ProviderConfig['type'][] = [
  'ollama',
  'openai',
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

function parseArgs(argv: string[]): ServiceOnboardingArgs {
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
      case '--force':
        args.force = true;
        break;
      case '--config':
        args.configPath = next;
        index += 1;
        break;
      case '--workspace':
        args.workspace = next;
        index += 1;
        break;
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

// forka #11: the default on-device medical model + Ollama URL, used whenever the
// medical provider resolves to Ollama (which is the default, independent of the
// main provider).
const ONDEVICE_OLLAMA_URL = 'http://localhost:11434/v1';
function defaultMedgemmaModel(): string {
  return getDefaultConfig().providers.medical.model;
}

function applyProvider(
  config: AppConfig,
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
    config.providers.main = {
      type: providerType,
      model: args.mainModel ?? 'gpt-4o-mini',
      ...(args.ollamaUrl ? { baseUrl: args.ollamaUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
    config.providers.embeddings = {
      type: providerType,
      model: args.embeddingModel ?? 'text-embedding-3-small',
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
  return {
    configPath: resolveSetupPath(args.configPath ?? defaultConfigPath()),
    workspacePath: resolveSetupPath(args.workspace ?? defaults.memory.workspace),
    telegramToken: args.telegramToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '',
    providerType: args.provider ?? defaults.providers.main.type,
  };
}

export function resolveNonInteractiveArgs(args: ServiceOnboardingArgs): ServiceOnboardingArgs {
  const defaults = getDefaultConfig();
  const values = resolveSetupValues(args);
  const providerDefaults = modelDefaultsForProvider(values.providerType);

  return {
    ...args,
    configPath: values.configPath,
    workspace: values.workspacePath,
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

export function buildConfigFromArgs(inputArgs: ServiceOnboardingArgs): AppConfig {
  const args = resolveNonInteractiveArgs(inputArgs);
  const defaults = getDefaultConfig();
  const values = resolveSetupValues(args);
  const config = getDefaultConfig();

  config.memory.workspace = values.workspacePath;
  config.heartbeat.storePath = path.join(path.dirname(values.configPath), 'heartbeats', 'jobs.json');
  config.heartbeat.audit.path = path.join(path.dirname(values.configPath), 'heartbeats', 'audit.jsonl');
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
    workspace: resolved.workspace ?? resolveSetupPath(defaults.memory.workspace),
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

export function collectSetupErrors(args: ServiceOnboardingArgs, config: AppConfig): string[] {
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

export async function persistSetupArtifacts(configPath: string, config: AppConfig): Promise<void> {
  ensureWorkspaceTemplates(config.memory.workspace);
  ensureParent(configPath);
  secureMkdir(path.join(path.dirname(configPath), 'sessions'));
  secureMkdir(path.dirname(config.heartbeat.storePath));
  await saveConfig(configPath, config);
}

export interface DaemonLaunchSpec {
  entrypoint: string;
  args: string[];
}

export interface CompletionActionDependencies {
  existsSync?: (filePath: string) => boolean;
  projectRoot?: string;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    on: (event: 'error' | 'exit', listener: (...args: unknown[]) => void) => unknown;
    unref?: () => void;
    pid?: number;
  };
  startupWindowMs?: number;
}

export interface OnboardingDependencies extends CompletionActionDependencies, SetupReadinessDependencies {}

export function resolveDaemonLaunchSpec(
  projectRoot = process.cwd(),
  existsSync: (filePath: string) => boolean = fs.existsSync,
): DaemonLaunchSpec {
  const distEntrypoint = path.join(projectRoot, 'dist', 'index.js');
  if (existsSync(distEntrypoint)) {
    return {
      entrypoint: distEntrypoint,
      args: [distEntrypoint],
    };
  }

  const sourceEntrypoint = path.join(projectRoot, 'src', 'index.ts');
  return {
    entrypoint: sourceEntrypoint,
    args: ['--import', 'tsx', sourceEntrypoint],
  };
}

export function startDaemon(
  configPath: string,
  io: CliIO,
  dependencies: CompletionActionDependencies = {},
): Promise<{ started: boolean; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (started: boolean, message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ started, message });
    };

    try {
      const projectRoot = dependencies.projectRoot ?? process.cwd();
      const spec = resolveDaemonLaunchSpec(projectRoot, dependencies.existsSync);
      const spawnProcess = dependencies.spawnProcess ?? spawn;
      const child = spawnProcess(process.execPath, spec.args, {
        cwd: projectRoot,
        detached: true,
        env: {
          ...process.env,
          REDACTED_CONFIG_PATH: configPath,
        },
        stdio: 'ignore',
      });
      child.unref?.();

      timer = setTimeout(() => {
        // forka #9: the daemon is detached (its own process group), so Ctrl-C in
        // this wizard does NOT stop it. Write a pid file next to the config and
        // tell the user exactly how to stop it, so a detached start is not a
        // surprise.
        let stopHint = '';
        if (child.pid) {
          const pidPath = path.join(path.dirname(configPath), 'redacted.pid');
          try {
            fs.writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
            fs.chmodSync(pidPath, 0o600);
          } catch {
            // best-effort; the stop hint below still works without the file
          }
          stopHint = ` It runs in the background — to stop it: kill ${child.pid}`;
        }
        finish(true, `MedClaw started${child.pid ? ` (pid ${child.pid})` : ''}.${stopHint}`);
      }, dependencies.startupWindowMs ?? 3000);

      child.on('error', (error: unknown) => {
        if (timer) {
          clearTimeout(timer);
        }
        finish(
          false,
          `Failed to start MedClaw: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      child.on('exit', (code, signal) => {
        if (timer) {
          clearTimeout(timer);
        }
        finish(false, `MedClaw exited during startup (${signal ?? code ?? 'unknown'}).`);
      });
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
      }
      finish(false, `Failed to start MedClaw: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export async function handleCompletionAction(
  action: CompletionAction,
  configPath: string,
  io: CliIO,
  dependencies: OnboardingDependencies = {},
): Promise<number> {
  if (action === 'review-config') {
    io.stdout?.(await showConfig({ configPath }));
    return 0;
  }
  if (action === 'start') {
    const config = await loadConfig({ configPath, requireFile: true });
    const preflight = await preflightStartCheck(config, configPath, dependencies);
    for (const warning of preflight.warnings) {
      io.stdout?.(`[WARN] ${warning}\n`);
    }
    if (!preflight.ready) {
      for (const blocker of preflight.blockers) {
        io.stderr?.(`[BLOCKED] ${blocker}\n`);
      }
      return 1;
    }

    const result = await startDaemon(configPath, io, dependencies);
    if (!result.started) {
      io.stderr?.(`${result.message}\n`);
      return 1;
    }
    io.stdout?.(`${result.message}\n`);
    return 0;
  }
  return 0;
}

export async function runServiceOnboarding(
  argv: string[],
  io: CliIO = {},
  dependencies: OnboardingDependencies = {},
): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.provider && !isSupportedOnboardingProvider(args.provider)) {
      io.stderr?.(
        `Unsupported onboard provider: ${args.provider}. Supported choices: ${SUPPORTED_ONBOARDING_PROVIDERS.join(', ')}.\n`,
      );
      return 1;
    }

    if (!args.yes) {
      const initialState = createInitialWizardState(args);
      const { runSetupWizard } = await import('./setup-wizard');
      const { action, cancelled } = await runSetupWizard(io, initialState, dependencies);
      if (cancelled) {
        return 0;
      }
      return handleCompletionAction(action, initialState.configPath, io, dependencies);
    }

    const resolved = resolveNonInteractiveArgs(args);
    if (fs.existsSync(resolved.configPath ?? defaultConfigPath()) && !resolved.force) {
      io.stderr?.(`Config already exists at ${resolved.configPath}. Re-run with --force to overwrite it.\n`);
      return 1;
    }

    const config = buildConfigFromArgs(resolved);
    const errors = collectSetupErrors(resolved, config);
    if (errors.length > 0) {
      io.stderr?.(`${errors.join('\n')}\n`);
      return 1;
    }

    const values = resolveSetupValues(resolved);
    await persistSetupArtifacts(values.configPath, config);
    io.stdout?.('Setup complete.\n');
    io.stdout?.(showRedactedConfigSummary(config));
    return 0;
  } catch (error) {
    io.stderr?.(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
