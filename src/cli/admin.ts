import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';
import { getDefaultConfig, loadConfig, saveConfig } from '../config/config';
import { redactConfig, validateConfig } from '../config/validation';
import type { AppConfig } from '../config/types';
import { HeartbeatStore } from '../scheduler/store';
import { checkSystemReadiness } from '../providers/healthcheck';
import type { ProviderConfig } from '../config/types';

export interface AdminPaths {
  configPath?: string;
  workspacePath?: string;
  storePath?: string;
}

function readOptionalFile(filePath: string): string | undefined {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function summarizeMarkdown(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .replace(/^-\s*/, '')
        .replace(/^\*\*(.+?)\*\*:\s*/, '$1: ')
        .replace(/\*\*/g, ''),
    )
    .join('\n');
}

function formatLines(lines: string[]): string {
  return lines.filter((line) => line.length > 0).join('\n') + '\n';
}

function providerEnvVar(providerType: ProviderConfig['type']): string | undefined {
  switch (providerType) {
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'google':
      return 'GOOGLE_API_KEY';
    case 'ollama':
      return undefined;
  }
}

function providerApiKeyConfigured(provider: ProviderConfig): boolean {
  const envVar = providerEnvVar(provider.type);
  return Boolean(provider.apiKey?.trim() || (envVar && process.env[envVar]?.trim()));
}

function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const looksStructured =
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(\.\d+)?$/.test(trimmed) ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('"') ||
    trimmed.startsWith("'");
  if (!looksStructured) {
    return raw;
  }
  try {
    return JSON5.parse(trimmed);
  } catch {
    return raw;
  }
}

function setPathValue(target: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Config path is required.');
  }

  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  cursor[parts[parts.length - 1]] = value;
}

export async function showConfig(paths: AdminPaths = {}): Promise<string> {
  const config = await loadConfig(paths.configPath);
  return showRedactedConfigSummary(config);
}

export async function setConfigValue(
  configPath: string,
  dottedPath: string,
  rawValue: string,
): Promise<string> {
  const config = await loadConfig({ configPath, requireFile: true });
  setPathValue(config as unknown as Record<string, unknown>, dottedPath, parseConfigValue(rawValue));
  await saveConfig(configPath, config);
  return `Updated ${dottedPath}\n`;
}

export async function showProfile(paths: AdminPaths = {}): Promise<string> {
  const workspacePath = paths.workspacePath ?? getDefaultConfig().memory.workspace;
  const filePath = path.join(workspacePath, 'HEALTH_PROFILE.md');
  const contents = readOptionalFile(filePath);
  if (!contents) {
    return formatLines([`No health profile found at ${filePath}.`]);
  }
  return formatLines([contents.trimEnd()]);
}

export async function showUserSummary(paths: AdminPaths = {}): Promise<string> {
  const workspacePath = paths.workspacePath ?? getDefaultConfig().memory.workspace;
  const user = readOptionalFile(path.join(workspacePath, 'USER.md'))
    ? summarizeMarkdown(readOptionalFile(path.join(workspacePath, 'USER.md')) ?? '')
    : 'No USER.md found.';
  const profile =
    readOptionalFile(path.join(workspacePath, 'HEALTH_PROFILE.md'))
      ? summarizeMarkdown(readOptionalFile(path.join(workspacePath, 'HEALTH_PROFILE.md')) ?? '')
      : 'No HEALTH_PROFILE.md found.';
  const heartbeat =
    readOptionalFile(path.join(workspacePath, 'HEARTBEAT.md'))
      ? summarizeMarkdown(readOptionalFile(path.join(workspacePath, 'HEARTBEAT.md')) ?? '')
      : 'No HEARTBEAT.md found.';

  return formatLines([
    `Workspace: ${workspacePath}`,
    '',
    'USER.md',
    user,
    '',
    'HEALTH_PROFILE.md',
    profile,
    '',
    'HEARTBEAT.md',
    heartbeat,
  ]);
}

function formatHeartbeatJob(job: {
  id: string;
  title: string;
  chatId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  deliveryState: string;
  prompt: string;
}): string {
  return [
    `id: ${job.id}`,
    `title: ${job.title}`,
    `chatId: ${job.chatId}`,
    `cron: ${job.cron}`,
    `timezone: ${job.timezone}`,
    `enabled: ${job.enabled}`,
    `deliveryState: ${job.deliveryState}`,
    `prompt: ${job.prompt}`,
  ].join('\n');
}

export async function listHeartbeats(paths: AdminPaths = {}): Promise<string> {
  const storePath = paths.storePath ?? getDefaultConfig().heartbeat.storePath;
  const store = new HeartbeatStore(storePath);
  const jobs = await store.list();
  if (jobs.length === 0) {
    return 'No heartbeat jobs configured.\n';
  }
  return formatLines(jobs.map((job) => formatHeartbeatJob(job)));
}

export function showRedactedConfigSummary(config: AppConfig): string {
  const redacted = redactConfig(config);
  const lines = [
    `workspace: ${redacted.memory.workspace}`,
    `provider: ${redacted.providers.main.type}`,
    `main model: ${redacted.providers.main.model}`,
    `medical model: ${redacted.providers.medical.model}`,
    `embedding model: ${redacted.providers.embeddings.model}`,
  ];

  if (redacted.providers.main.type === 'ollama') {
    lines.push(`ollama url: ${redacted.providers.main.baseUrl ?? '(not set)'}`);
  } else {
    lines.push(`provider api key: ${providerApiKeyConfigured(config.providers.main) ? 'configured' : 'not set'}`);
  }

  lines.push(`telegram: ${redacted.channels.telegram.enabled ? 'enabled' : 'disabled'}`);
  if (redacted.channels.telegram.enabled) {
    lines.push(`telegram token: ${redacted.channels.telegram.botToken ? '[REDACTED]' : '(not set)'}`);
  }
  lines.push(`timezone: ${redacted.heartbeat.timezone}`);
  lines.push(`heartbeats: ${redacted.heartbeat.enabled ? 'enabled' : 'disabled'}`);

  return formatLines(lines);
}

export function buildReadinessSummaryLines(input: {
  configPath?: string;
  workspacePath: string;
  validation: ReturnType<typeof validateConfig>;
  readiness: Awaited<ReturnType<typeof checkSystemReadiness>>;
  heartbeatCount?: number;
}): string[] {
  const runtimeReady =
    input.readiness.providers.every((result) => result.ready) &&
    input.readiness.telegram.ready;
  const telegramLine = input.readiness.telegram.details.includes('disabled')
    ? 'disabled'
    : formatReadiness(input.readiness.telegram);
  const lines = [
    `status: ${input.validation.valid && runtimeReady ? 'ok' : 'degraded'}`,
    `config: ${input.configPath ?? '(default)'}`,
    `workspace: ${input.workspacePath}`,
    `main provider: ${formatReadiness(input.readiness.providers[0])}`,
    `medical provider: ${formatReadiness(input.readiness.providers[1])}`,
    `embeddings provider: ${formatReadiness(input.readiness.providers[2])}`,
    `telegram: ${telegramLine}`,
  ];

  if (input.heartbeatCount !== undefined) {
    lines.push(`heartbeat jobs: ${input.heartbeatCount}`);
  }

  for (const result of [...input.readiness.providers, input.readiness.telegram]) {
    if (result.status === 'ok' && result.warnings.length === 0) {
      continue;
    }
    for (const detail of result.details) {
      lines.push(`  ${result.label}: ${detail}`);
    }
    for (const warning of result.warnings) {
      lines.push(`  ${result.label}: ${warning}`);
    }
    if (result.actionHint) {
      lines.push(`  ${result.label} hint: ${result.actionHint}`);
    }
  }

  if (input.validation.errors.length > 0) {
    lines.push('', 'validation errors:');
    lines.push(...input.validation.errors.map((error) => `- ${error}`));
  }
  if (input.validation.warnings.length > 0) {
    lines.push('', 'validation warnings:');
    lines.push(...input.validation.warnings.map((warning) => `- ${warning}`));
  }

  return lines;
}

export async function showStatus(paths: AdminPaths = {}): Promise<string> {
  const config = await loadConfig(paths.configPath);
  const workspacePath = paths.workspacePath ?? config.memory.workspace;
  const storePath = paths.storePath ?? config.heartbeat.storePath;
  const health = await checkSystemReadiness(config, { allowNetworkChecks: false });
  const heartbeatCount = (await new HeartbeatStore(storePath).list()).length;
  const validation = validateConfig(config);
  const lines = buildReadinessSummaryLines({
    configPath: paths.configPath,
    workspacePath,
    validation,
    readiness: health,
    heartbeatCount,
  });
  return formatLines(lines);
}

export function formatReadiness(result: { ready: boolean; checked: boolean }): string {
  if ('status' in result && result.status === 'warn') {
    return result.checked ? 'degraded' : 'configured';
  }
  if (!result.ready) {
    return 'not ready';
  }
  return result.checked ? 'ready' : 'configured';
}
