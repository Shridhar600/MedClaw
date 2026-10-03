import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import JSON5 from 'json5';
import { decodeConfigDocument } from '../config';
import {
  canonicalizeConfigPath,
  effectiveConfigFor,
  describeRefusal,
  readConfigDocument,
  writeConfigDocument,
} from '../runtime/installation';
import type { ConfigFileSync } from '../runtime/installation';
import { DirectoryLease } from '../runtime/adapters/directory-lease';
import { CryptoPairingCodePort, FileOwnerStatePort } from '../runtime/adapters';
import { InstallationService, describeOwnershipRefusal } from '../runtime/installation';
import { OwnerAdmissionService, isBoundOwnerState } from '../profiles';
import { systemClock } from '../ports/defaults';
import type { ResourceLeasePort } from '../ports/resource-lease';
import { defaultRuntimeConfigPath } from '../runtime/startup';
import { redactConfig, validateConfig, protectedSetReason } from '../config/validation';
import type { EffectiveConfig, StoredConfig } from '../config/types';
import { providerEnvVar } from '../config/provider-env';
import { HeartbeatStore } from '../scheduler/store';
import { checkSystemReadiness } from '../providers/healthcheck';
import type { ProviderConfig } from '../config/types';

export interface AdminPaths {
  configPath?: string;
  workspacePath?: string;
  storePath?: string;
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
  for (const part of parts) {
    if (part === '__proto__' || part === 'prototype' || part === 'constructor') {
      throw new Error(`Unsafe config path segment: ${part}`);
    }
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
  const selected = paths.configPath ?? defaultRuntimeConfigPath();
  const { stored } = readConfigDocument(selected, os.homedir());
  return showRedactedConfigSummary(effectiveConfigFor(stored));
}

/**
 * Change one declared non-identity setting, offline.
 *
 * Refusals keep the original bytes byte-for-byte intact:
 *  - the path selects identity or is derived → refused before any read-modify-write;
 *  - the resulting document would not decode → refused before any write;
 *  - the replacement did not reach the filesystem → `failed`, original bytes preserved.
 *
 * When the rename committed but a durability step failed, the outcome is `uncertain`:
 * the message says the current content is not proven and must be inspected, and it does not
 * restore anything (plan 15 §8).
 */
export async function setConfigValue(
  configPath: string,
  dottedPath: string,
  rawValue: string,
  options: { sync?: ConfigFileSync; leases?: ResourceLeasePort } = {},
): Promise<string> {
  const protectedReason = protectedSetReason(dottedPath);
  if (protectedReason) {
    throw new Error(
      `Cannot set ${dottedPath}: ${protectedReason}. Edit the configuration through setup instead.`,
    );
  }

  // Coordinate on the canonical CONFIG resource, not on any mutable profile identity. Two
  // supported contenders cannot both report success: the loser is refused immediately.
  const leases = options.leases ?? new DirectoryLease();
  const { canonicalPath: canonicalForLease } = canonicalizeConfigPath(configPath);
  const configLease = await leases.tryAcquire({ kind: 'config', canonicalPath: canonicalForLease });
  if (configLease.kind === 'busy') {
    throw new Error(`Cannot set ${dottedPath}: ${configLease.guidance}`);
  }
  if (configLease.kind === 'unavailable') {
    throw new Error(`Cannot set ${dottedPath}: ${configLease.guidance}`);
  }

  try {
    return await applyConfigValueUnderLease(
      configLease.release,
      configPath,
      dottedPath,
      rawValue,
      options.sync,
    );
  } finally {
    await configLease.release();
  }
}

/**
 * Read-validate-replace while the caller holds the config lease.
 *
 * Split out so the lease is provably held for the whole read-modify-write, and so the release
 * happens in exactly one place.
 */
async function applyConfigValueUnderLease(
  release: () => Promise<void>,
  configPath: string,
  dottedPath: string,
  rawValue: string,
  sync: ConfigFileSync | undefined,
): Promise<string> {
  const { stored, canonicalPath } = readConfigDocument(configPath, os.homedir());
  const next = structuredClone(stored) as unknown as Record<string, unknown>;
  setPathValue(next, dottedPath, parseConfigValue(rawValue));

  // Validate the whole document through the same decoder startup uses, so a `config set`
  // can never persist a value that refuses to serve.
  const decoded = decodeConfigDocument(next, { homeDir: os.homedir() });
  if (decoded.kind === 'invalid') {
    const detail = decoded.issues.map((issue) => `${issue.field}: ${issue.detail} [${issue.code}]`).join('; ');
    throw new Error(`Refused ${dottedPath}: the resulting configuration would not load. ${detail}`);
  }

  const outcome = writeConfigDocument(canonicalPath, decoded.config as StoredConfig, { sync });
  if (outcome.status === 'failed') {
    throw new Error(
      `Refused ${dottedPath}: ${describeRefusal(outcome.reason ?? 'write-failed')}. The configuration is unchanged.`,
    );
  }
  if (outcome.status === 'uncertain') {
    return [
      `Updated ${dottedPath}, but ${describeRefusal(outcome.reason ?? 'flush-failed')}.`,
      'The previous content was NOT restored. Inspect `medclaw config show` before retrying.',
      'Restart the daemon to load the change.',
    ].join('\n') + '\n';
  }
  return `Updated ${dottedPath}. Restart the daemon to load the change.\n`;
}

/**
 * Issue a fresh pairing code for an unpaired owner.
 *
 * Offline by construction: this runs under the owner's own resource ownership, so a running
 * daemon refuses the command rather than two writers racing on the record. The plaintext is
 * printed only after the replacement has committed — a failed write can never show a code that
 * was never stored.
 */
export async function issuePairingCode(options: AdminPaths = {}): Promise<string> {
  const selected = options.configPath ?? defaultRuntimeConfigPath();
  const services = new InstallationService(new DirectoryLease());
  const result = await services.acquireOwnership(selected, os.homedir());

  if (result.kind === 'invalid-config') {
    throw new Error(`Refused to issue a pairing code: ${result.message}`);
  }
  if (result.kind === 'busy' || result.kind === 'unavailable') {
    // A running daemon already owns this installation, so issuing here would race it.
    return `${describeOwnershipRefusal(result)}\nStop the daemon before issuing a pairing code.\n`;
  }

  const { ownerId, ownerPaths, release } = result.ownership;
  try {
    const admission = new OwnerAdmissionService({
      store: new FileOwnerStatePort(ownerPaths.ownerRecord, ownerId),
      codes: new CryptoPairingCodePort(),
      clock: systemClock,
      expectedOwnerId: ownerId,
      diagnostics: { recordPairingOutcome: () => {} },
    });

    const issued = await admission.issueChallenge();
    if (issued.kind === 'issued') {
      return [
        'Pairing code issued. Send this code from your own chat; it expires in 24 hours.',
        '',
        `    ${issued.plaintext}`,
        '',
        'It is shown once and is not stored. To replace a lost code, run this command again.',
      ].join('\n') + '\n';
    }
    if (issued.reason === 'already-bound') {
      return [
        'This installation is already paired. Rebinding or removing an owner is not supported.',
        '',
        'Only a bounded, one-use code can be reissued while an owner is unpaired.',
      ].join('\n') + '\n';
    }
    return [
      'Refused to issue a pairing code: the owner record could not be updated.',
      `Reason: ${issued.reason}. The previous record is unchanged; run \`medclaw config show\` to inspect it.`,
    ].join('\n') + '\n';
  } finally {
    await release();
  }
}

/** One honest line about pairing state. Pairing-pending is NOT readiness. */
function describePairingState(ownerRecordPath: string, ownerId: string): string {
  const read = new FileOwnerStatePort(ownerRecordPath, ownerId).read();
  if (read.kind === 'missing') return 'pairing: no owner record (re-run setup)';
  if (read.kind === 'unavailable') {
    return `pairing: unavailable (${read.reason}) — refusing to serve`;
  }
  if (isBoundOwnerState(read.state)) return 'pairing: bound';
  const hasChallenge = read.state.challenge !== undefined;
  const expiresAt = read.state.challenge?.expiresAt;
  return hasChallenge && expiresAt !== undefined
    ? `pairing: pending — code expires ${expiresAt}`
    : 'pairing: pending — no code issued (run `pairing issue`)';
}

/**
 * Local inspection reads are bounded. A growing Markdown file or job store above the limit
 * is reported as explicitly unavailable rather than being truncated into a healthy-looking
 * summary, and an unreadable file is never reported as an empty one.
 */
const MAX_INSPECTION_BYTES = 256 * 1024;

type InspectionRead =
  | { kind: 'ok'; text: string }
  | { kind: 'absent' }
  | { kind: 'unavailable'; detail: string };

function readInspectionFile(filePath: string): InspectionRead {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unavailable', detail: 'the file exists but its metadata could not be read' };
  }
  if (!stat.isFile()) return { kind: 'unavailable', detail: 'the path is not a regular file' };
  if (stat.size > MAX_INSPECTION_BYTES) {
    return { kind: 'unavailable', detail: `the file exceeds the ${MAX_INSPECTION_BYTES} byte local inspection limit` };
  }
  try {
    return { kind: 'ok', text: fs.readFileSync(filePath, 'utf8') };
  } catch {
    return { kind: 'unavailable', detail: 'the file could not be read' };
  }
}

function optionalInspectionText(filePath: string, label: string, missingLabel: string): string {
  const read = readInspectionFile(filePath);
  if (read.kind === 'unavailable') return `${label} unavailable: ${read.detail}.`;
  if (read.kind === 'absent') return missingLabel;
  return summarizeMarkdown(read.text);
}

/** Selected owner paths for a config path, or an explicit refusal. Never a default grant. */
function selectedOwnerPaths(configPath?: string): { workspace: string; storePath: string } {
  const selected = configPath ?? defaultRuntimeConfigPath();
  const { stored } = readConfigDocument(selected, os.homedir());
  const config = effectiveConfigFor(stored);
  return { workspace: config.memory.workspace, storePath: config.heartbeat.storePath };
}

export async function showProfile(paths: AdminPaths = {}): Promise<string> {
  const workspacePath = paths.workspacePath ?? selectedOwnerPaths(paths.configPath).workspace;
  const filePath = path.join(workspacePath, 'HEALTH_PROFILE.md');
  const read = readInspectionFile(filePath);
  if (read.kind === 'unavailable') {
    return formatLines([`HEALTH_PROFILE.md unavailable: ${read.detail}.`]);
  }
  if (read.kind === 'absent') {
    return formatLines([`No health profile found at ${filePath}.`]);
  }
  return formatLines([read.text.trimEnd()]);
}

export async function showUserSummary(paths: AdminPaths = {}): Promise<string> {
  const workspacePath = paths.workspacePath ?? selectedOwnerPaths(paths.configPath).workspace;
  const user = optionalInspectionText(path.join(workspacePath, 'USER.md'), 'USER.md', 'No USER.md found.');
  const profile = optionalInspectionText(
    path.join(workspacePath, 'HEALTH_PROFILE.md'),
    'HEALTH_PROFILE.md',
    'No HEALTH_PROFILE.md found.',
  );
  const heartbeat = optionalInspectionText(
    path.join(workspacePath, 'HEARTBEAT.md'),
    'HEARTBEAT.md',
    'No HEARTBEAT.md found.',
  );

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
  const storePath = paths.storePath ?? selectedOwnerPaths(paths.configPath).storePath;
  const probe = readInspectionFile(storePath);
  if (probe.kind === 'unavailable') {
    return `Heartbeat store unavailable: ${probe.detail}.\n`;
  }
  const store = new HeartbeatStore(storePath);
  const jobs = await store.list();
  if (jobs.length === 0) {
    return probe.kind === 'absent'
      ? 'No heartbeat jobs configured (the selected owner has no scheduler store yet).\n'
      : 'No heartbeat jobs configured.\n';
  }
  return formatLines(jobs.map((job) => formatHeartbeatJob(job)));
}

export function showRedactedConfigSummary(config: EffectiveConfig): string {
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
  const selected = paths.configPath ?? defaultRuntimeConfigPath();
  const { stored } = readConfigDocument(selected, os.homedir());
  const config = effectiveConfigFor(stored);
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
  // Pairing-pending is reported separately from readiness: a healthy provider and a valid
  // document still cannot serve a stranger until the owner is bound.
  lines.push(describePairingState(
    path.join(config.profiles.baseDir, 'profiles', config.profiles.defaultProfileId, '.state', 'owner-access.json'),
    config.profiles.defaultProfileId,
  ));
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
