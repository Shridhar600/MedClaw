// One configuration selection and one strict load, shared by the daemon and every retained
// CLI command. Selection precedence is `--config` > `REDACTED_CONFIG_PATH` >
// `home/.redacted/config.json`, and a missing flag value or unknown option is a usage
// error rather than a silent fallback.
//
// Load refuses when the document is missing, unreadable, oversized, malformed, on an old
// schema, or missing owner identity. A default never becomes an owner, and there is no
// healthy-empty or quarantine-to-empty read behavior.

import * as os from 'os';
import * as path from 'path';
import JSON5 from 'json5';
import { decodeConfigDocument, resolveEffectiveConfig } from '../config';
import { formatConfigIssue } from '../config/validation';
import type { EffectiveConfig } from '../config';
import { readConfigFile, type ConfigFileReason } from './adapters/config-file';
import { asProfileId, resolveOwnerPaths, derivedPathsFor } from '../profiles';

export const ONBOARD_GUIDANCE = 'Run `npm run cli -- onboard` to create one, or pass --config with an existing config path.';

export class ConfigSelectionError extends Error {
  readonly usage = true;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigSelectionError';
  }
}

export class ConfigUnavailableError extends Error {
  readonly usage = false;
  constructor(
    readonly reason: ConfigFileReason | 'invalid-document' | 'invalid-owner-id',
    message: string,
  ) {
    super(message);
    this.name = 'ConfigUnavailableError';
  }
}

export function defaultRuntimeConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.redacted', 'config.json');
}

export interface ConfigSelectionInput {
  /** Value of an explicit `--config <path>`. `undefined` means the flag was absent. */
  flagValue?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * Resolve which configuration document to use. The flag wins; then a non-empty environment
 * variable; then the home default. A relative flag value resolves against the caller cwd,
 * which is what a shell user means by it.
 */
export function selectConfigPath(input: ConfigSelectionInput = {}): string {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? os.homedir();
  if (input.flagValue !== undefined) {
    if (input.flagValue.trim() === '') {
      throw new ConfigSelectionError('--config requires a path. Usage: medclaw --config <path> <command>');
    }
    return path.resolve(input.flagValue);
  }
  const fromEnv = env.REDACTED_CONFIG_PATH?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  return defaultRuntimeConfigPath(homeDir);
}

export interface GlobalOptionParse {
  configPath?: string;
  help: boolean;
  rest: string[];
}

/**
 * Global options are recognised only BEFORE the command. Once a bare token (the command name) is seen,
 * everything after it belongs to that command's own parser. An unrecognised flag before the command is
 * refused, so a typo in the global position is not silently forwarded.
 */
export function parseGlobalOptions(argv: ReadonlyArray<string>): GlobalOptionParse {
  let configPath: string | undefined;
  let help = false;
  const rest: string[] = [];
  let sawCommand = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!sawCommand && token === '--') {
      sawCommand = true;
      continue;
    }
    if (!sawCommand) {
      if (token === '--help' || token === '-h' || token === 'help') {
        help = true;
        continue;
      }
      if (token === '--config') {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          throw new ConfigSelectionError('--config requires a path. Usage: medclaw --config <path> <command>');
        }
        configPath = value;
        index += 1;
        continue;
      }
      if (token.startsWith('-')) {
        // Name only — never the text after '=', which is a value and may be a secret. A token that
        // is not a long option is never a supported name, so it is not echoed at all.
        if (!token.startsWith('--')) {
          throw new ConfigSelectionError(
            `Unknown option at position ${index + 1}. Run \`medclaw --help\` for the supported options.`,
          );
        }
        const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
        throw new ConfigSelectionError(`Unknown option: ${name}. Run \`medclaw --help\` for the supported options.`);
      }
      sawCommand = true;
    }
    rest.push(token);
  }

  return { configPath, help, rest };
}

export interface LoadRuntimeConfigOptions {
  configPath?: string;
  homeDir?: string;
}

/**
 * Read, validate and derive the runtime configuration.
 *
 * Every refusal names an allowlisted reason and keeps the original document untouched.
 * Derived owner paths come from `resolveOwnerPaths`, so the document has exactly one path
 * authority.
 */
export async function loadRuntimeConfig(options: LoadRuntimeConfigOptions = {}): Promise<EffectiveConfig> {
  const homeDir = options.homeDir ?? os.homedir();
  const selected = selectConfigPath({ flagValue: options.configPath, env: process.env, homeDir });

  const read = readConfigFile(selected);
  if (read.kind === 'missing') {
    throw new ConfigUnavailableError(
      'missing',
      `Config file not found at ${selected}. ${ONBOARD_GUIDANCE}`,
    );
  }
  if (read.kind === 'unavailable') {
    throw new ConfigUnavailableError(
      read.reason,
      `Config file at ${selected} is unusable (${read.reason}). ${ONBOARD_GUIDANCE}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(read.text);
  } catch {
    throw new ConfigUnavailableError(
      'invalid-document',
      `Config file at ${selected} is not parseable JSON/JSON5. ${ONBOARD_GUIDANCE}`,
    );
  }

  const decoded = decodeConfigDocument(parsed, { homeDir });
  if (decoded.kind === 'invalid') {
    const detail = decoded.issues.map(formatConfigIssue).join('; ');
    throw new ConfigUnavailableError(
      'invalid-document',
      `Config file at ${selected} was refused: ${detail}. ${ONBOARD_GUIDANCE}`,
    );
  }

  const ownerId = asProfileId(decoded.config.profiles.defaultProfileId);
  if (ownerId === undefined) {
    throw new ConfigUnavailableError(
      'invalid-owner-id',
      `Config file at ${selected} names an owner ID that is not valid. ${ONBOARD_GUIDANCE}`,
    );
  }

  const ownerPaths = resolveOwnerPaths(decoded.config.profiles.baseDir, ownerId);
  return resolveEffectiveConfig(decoded.config, derivedPathsFor(ownerPaths));
}

export { MAX_CONFIG_BYTES, readConfigFile } from './adapters/config-file';
