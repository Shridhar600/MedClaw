import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';
import { getDefaultConfig, loadConfig, saveConfig } from '../config/config';
import { redactConfig, validateConfig } from '../config/validation';
import { HeartbeatStore } from '../scheduler/store';
import { checkSystemReadiness } from '../providers/healthcheck';

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
  return formatLines([JSON.stringify(redactConfig(config), null, 2)]);
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

export async function showStatus(paths: AdminPaths = {}): Promise<string> {
  const config = await loadConfig(paths.configPath);
  const workspacePath = paths.workspacePath ?? config.memory.workspace;
  const storePath = paths.storePath ?? config.heartbeat.storePath;
  const health = await checkSystemReadiness(config, { allowNetworkChecks: false });
  const heartbeatCount = (await new HeartbeatStore(storePath).list()).length;
  const validation = validateConfig(config);

  const lines = [
    `status: ${validation.valid ? 'ok' : 'degraded'}`,
    `config: ${paths.configPath ?? '(default)'}`,
    `workspace: ${workspacePath}`,
    `main provider: ${formatReadiness(health.providers[0])}`,
    `medical provider: ${formatReadiness(health.providers[1])}`,
    `embeddings provider: ${formatReadiness(health.providers[2])}`,
    `telegram: ${config.channels.telegram.enabled ? formatReadiness(health.telegram) : 'disabled'}`,
    `heartbeat jobs: ${heartbeatCount}`,
  ];

  if (validation.errors.length > 0) {
    lines.push('', 'validation errors:');
    lines.push(...validation.errors.map((error) => `- ${error}`));
  }
  if (validation.warnings.length > 0) {
    lines.push('', 'validation warnings:');
    lines.push(...validation.warnings.map((warning) => `- ${warning}`));
  }

  return formatLines(lines);
}

function formatReadiness(result: { ready: boolean; checked: boolean }): string {
  if (!result.ready) {
    return 'not ready';
  }
  return result.checked ? 'ready' : 'configured (not checked)';
}
