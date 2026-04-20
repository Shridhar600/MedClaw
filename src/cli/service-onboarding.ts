import * as fs from 'fs';
import * as path from 'path';
import { getDefaultConfig, saveConfig } from '../config/config';
import { validateConfig } from '../config/validation';
import type { AppConfig, ProviderConfig } from '../config/types';
import { redactConfig } from '../config/validation';
import { askText, askYesNo, ensureWorkspaceTemplates, type CliIO } from './prompts';

export interface ServiceOnboardingArgs {
  yes?: boolean;
  configPath?: string;
  workspace?: string;
  provider?: ProviderConfig['type'];
  mainModel?: string;
  medicalModel?: string;
  embeddingModel?: string;
  ollamaUrl?: string;
  apiKey?: string;
  telegramToken?: string;
  telegramEnabled?: boolean;
  timezone?: string;
  heartbeatsEnabled?: boolean;
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function applyProvider(
  config: AppConfig,
  providerType: ProviderConfig['type'],
  args: ServiceOnboardingArgs,
): void {
  if (providerType === 'ollama') {
    const baseUrl = args.ollamaUrl ?? config.providers.main.baseUrl;
    config.providers.main = {
      type: 'ollama',
      model: args.mainModel ?? config.providers.main.model,
      baseUrl,
    };
    config.providers.medical = {
      type: 'ollama',
      model: args.medicalModel ?? config.providers.medical.model,
      baseUrl,
    };
    config.providers.embeddings = {
      type: 'ollama',
      model: args.embeddingModel ?? config.providers.embeddings.model,
      baseUrl,
    };
    return;
  }

  const apiKey = args.apiKey;
  config.providers.main = {
    type: providerType,
    model: args.mainModel ?? 'gpt-4o-mini',
    ...(args.ollamaUrl ? { baseUrl: args.ollamaUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
  config.providers.medical = {
    type: providerType,
    model: args.medicalModel ?? 'gpt-4o-mini',
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

function requiredCloudEnv(providerType: ProviderConfig['type']): string {
  switch (providerType) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'google':
      return 'GOOGLE_API_KEY';
    case 'ollama':
      return '';
  }
}

function modelDefaultsForProvider(providerType: ProviderConfig['type']): {
  main: string;
  medical: string;
  embeddings: string;
} {
  if (providerType === 'openai') {
    return {
      main: 'gpt-4o-mini',
      medical: 'gpt-4o-mini',
      embeddings: 'text-embedding-3-small',
    };
  }

  const defaults = getDefaultConfig();
  return {
    main: defaults.providers.main.model,
    medical: defaults.providers.medical.model,
    embeddings: defaults.providers.embeddings.model,
  };
}

function providerLabel(providerType: ProviderConfig['type']): string {
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

async function promptForMissingArgs(io: CliIO, args: ServiceOnboardingArgs): Promise<ServiceOnboardingArgs> {
  if (args.workspace === undefined) {
    args.workspace = await askText(io, 'Workspace path', getDefaultConfig().memory.workspace);
  }
  if (args.provider === undefined) {
    args.provider = (await askText(io, 'Provider type', 'ollama')) as ProviderConfig['type'];
  }
  if (
    args.provider !== 'ollama' &&
    args.apiKey === undefined &&
    !process.env[requiredCloudEnv(args.provider)]?.trim()
  ) {
    args.apiKey = await askText(io, `${providerLabel(args.provider)} API key`, '');
  }
  const modelDefaults = modelDefaultsForProvider(args.provider);
  if (args.mainModel === undefined) {
    args.mainModel = await askText(io, 'Main model', modelDefaults.main);
  }
  if (args.medicalModel === undefined) {
    args.medicalModel = await askText(io, 'Medical model', modelDefaults.medical);
  }
  if (args.embeddingModel === undefined) {
    args.embeddingModel = await askText(io, 'Embedding model', modelDefaults.embeddings);
  }
  if (args.ollamaUrl === undefined && args.provider === 'ollama') {
    args.ollamaUrl = await askText(io, 'Ollama URL', getDefaultConfig().providers.main.baseUrl ?? '');
  }
  if (args.telegramEnabled === undefined) {
    args.telegramEnabled = await askYesNo(io, 'Enable Telegram?', true);
  }
  if (args.telegramEnabled && !args.telegramToken) {
    args.telegramToken = await askText(io, 'Telegram bot token', '');
  }
  if (args.timezone === undefined) {
    args.timezone = await askText(io, 'Timezone', getDefaultConfig().heartbeat.timezone);
  }
  if (args.heartbeatsEnabled === undefined) {
    args.heartbeatsEnabled = await askYesNo(io, 'Enable heartbeats?', true);
  }
  return args;
}

export async function runServiceOnboarding(
  argv: string[],
  io: CliIO = {},
): Promise<number> {
  try {
    const args = parseArgs(argv);
    const interactive = !args.yes;
    const resolved = interactive ? await promptForMissingArgs(io, args) : args;
    const defaults = getDefaultConfig();
    const configPath = resolved.configPath ?? path.join(process.env.HOME ?? '', '.redacted', 'config.json');
    const workspacePath = resolved.workspace ?? defaults.memory.workspace;
    const telegramToken = resolved.telegramToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '';
    const providerType = resolved.provider ?? defaults.providers.main.type;

    if (providerType !== 'ollama' && !resolved.apiKey?.trim() && !process.env[requiredCloudEnv(providerType)]?.trim()) {
      io.stderr?.(`${requiredCloudEnv(providerType)} or --api-key is required for provider ${providerType}.\n`);
      return 1;
    }

    if (resolved.telegramEnabled !== false && !telegramToken.trim()) {
      io.stderr?.('telegram is enabled but no bot token was provided.\n');
      return 1;
    }

    ensureWorkspaceTemplates(workspacePath);

    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.heartbeat.storePath = path.join(path.dirname(configPath), 'heartbeats', 'jobs.json');
    config.heartbeat.audit.path = path.join(path.dirname(configPath), 'heartbeats', 'audit.jsonl');
    config.heartbeat.timezone = resolved.timezone ?? config.heartbeat.timezone;
    config.heartbeat.enabled = resolved.heartbeatsEnabled ?? config.heartbeat.enabled;
    config.channels.telegram.enabled = resolved.telegramEnabled ?? config.channels.telegram.enabled;
    config.channels.telegram.botToken = config.channels.telegram.enabled ? telegramToken : '';

    applyProvider(config, providerType, resolved);

    const validation = validateConfig(config);
    if (!validation.valid) {
      io.stderr?.(`${validation.errors.join('\n')}\n`);
      return 1;
    }

    ensureParent(configPath);
    fs.mkdirSync(path.join(path.dirname(configPath), 'sessions'), { recursive: true });
    fs.mkdirSync(path.dirname(config.heartbeat.storePath), { recursive: true });
    await saveConfig(configPath, config);

    io.stdout?.(`Initialized Redacted at ${workspacePath}\n`);
    io.stdout?.(`Config written to ${configPath}\n`);
    io.stdout?.(`${JSON.stringify(redactConfig(config), null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr?.(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
