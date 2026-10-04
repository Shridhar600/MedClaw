import { loadRuntimeConfig, parseGlobalOptions, selectConfigPath } from '../runtime';
import {
  issuePairingCode,
  listHeartbeats,
  setConfigValue,
  showConfig,
  showProfile,
  showStatus,
  showUserSummary,
} from './admin';
import { runServiceOnboarding } from './service-onboarding';
import type { CliIO } from './prompts';

function defaultIO(): CliIO {
  return {
    stdout: (text: string) => process.stdout.write(text),
    stderr: (text: string) => process.stderr.write(text),
  };
}

function helpText(): string {
  return [
    'Usage: medclaw <command> [options]',
    '',
    'Commands:',
    '  onboard',
    '  init (alias for onboard)',
    '  status',
    '  config show',
    '  config set <path> <value>',
    '  profile show',
    '  user summary',
    '  heartbeats list',
    '  pairing issue                (offline; only while the owner is unpaired)',
    '',
    'Global options:',
    '  --help',
    '  --config <path>',
    '',
    'Configuration is selected in this order:',
    '  --config <path>, then REDACTED_CONFIG_PATH, then ~/.redacted/config.json',
  ].join('\n') + '\n';
}

/**
 * Load the ALREADY-RESOLVED selected configuration. Refuses when the document is unavailable, so no
 * inspection command can fall back to a default identity or report a healthy-empty result.
 *
 * This deliberately takes an absolute, already-selected path rather than an optional flag value.
 * It used to do the selection itself with `flagConfigPath ?? defaultRuntimeConfigPath()`, which is
 * how the environment step got skipped: eight hand-written copies of that expression across this
 * file and `admin.ts` meant any one of them could reintroduce the bug. Selection now happens exactly
 * once, in `runCli`, through the single locked implementation.
 */
async function selectedConfig(resolvedConfigPath: string) {
  return loadRuntimeConfig({ configPath: resolvedConfigPath });
}

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const mergedIO = { ...defaultIO(), ...io };
  const { configPath, rest, help } = parseGlobalOptions(argv);

  if (help || rest.length === 0) {
    mergedIO.stdout?.(helpText());
    return 0;
  }

  // ── THE single point where configuration selection happens ──
  //
  // Brief T1 requires `--config > REDACTED_CONFIG_PATH > ~/.redacted/config.json` to apply
  // "everywhere". It used to be re-derived by hand at eight call sites as
  // `configPath ?? defaultRuntimeConfigPath()`, which silently skips the environment step: the flag
  // arrived here, but `REDACTED_CONFIG_PATH` never did. `onboard` compounded it by manufacturing a
  // `--config` flag containing the default, so a correct selection anywhere downstream could not
  // recover. The result was a daemon serving one installation while `status`, `config set` and
  // `pairing issue` read or mutated another.
  //
  // Resolved once, here, and passed down explicitly. Every downstream helper now takes a required
  // resolved path, so there is no second place to get this wrong. `selectConfigPath` also validates
  // a present-but-empty `--config` and resolves relative values against the cwd.
  let selectedConfigPath: string;
  try {
    selectedConfigPath = selectConfigPath({ flagValue: configPath });
  } catch (error) {
    mergedIO.stderr?.(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const [command, ...commandArgs] = rest;

  // Global option parsing stops at the command, so `onboard --yes --owner-id kiran` reaches that
  // command's own parser. A command that declares no options of its own must still refuse a stray
  // flag rather than silently ignore it (`status --bogus`), so the refusal lives here instead.
  if (command !== 'onboard' && command !== 'init' && command !== 'config') {
    const stray = commandArgs.find((token) => token.startsWith('-'));
    if (stray !== undefined) {
      mergedIO.stderr?.(`Unknown option for \`${command}\`: ${stray}. Run \`medclaw ${command} --help\`.\n`);
      return 1;
    }
  }

  try {
    if (command === 'init' || command === 'onboard') {
      return await runServiceOnboarding(
        ['--config', selectedConfigPath, ...commandArgs],
        mergedIO,
      );
    }

    if (command === 'status') {
      mergedIO.stdout?.(await showStatus({ configPath: selectedConfigPath }));
      return 0;
    }

    if (command === 'config') {
      const [subcommand, ...subArgs] = commandArgs;
      if (subcommand === 'show') {
        mergedIO.stdout?.(await showConfig({ configPath: selectedConfigPath }));
        return 0;
      }
      if (subcommand === 'set') {
        const [configKey, ...valueParts] = subArgs;
        if (!configKey || valueParts.length === 0) {
          mergedIO.stderr?.('Usage: config set <path> <value>\n');
          return 1;
        }
        const value = valueParts.join(' ');
        mergedIO.stdout?.(
          await setConfigValue(selectedConfigPath, configKey, value),
        );
        return 0;
      }
      mergedIO.stderr?.(`Unknown config command: ${subcommand ?? '(missing)'}\n`);
      return 1;
    }

    if (command === 'profile') {
      const [subcommand] = commandArgs;
      if (subcommand === 'show') {
        const config = await selectedConfig(selectedConfigPath);
        mergedIO.stdout?.(await showProfile({ workspacePath: config.memory.workspace }));
        return 0;
      }
      mergedIO.stderr?.(`Unknown profile command: ${subcommand ?? '(missing)'}\n`);
      return 1;
    }

    if (command === 'user') {
      const [subcommand] = commandArgs;
      if (subcommand === 'summary') {
        const config = await selectedConfig(selectedConfigPath);
        mergedIO.stdout?.(await showUserSummary({ workspacePath: config.memory.workspace }));
        return 0;
      }
      mergedIO.stderr?.(`Unknown user command: ${subcommand ?? '(missing)'}\n`);
      return 1;
    }

    if (command === 'pairing') {
      const [subcommand] = commandArgs;
      if (subcommand === 'issue') {
        mergedIO.stdout?.(
          await issuePairingCode({ configPath: selectedConfigPath }),
        );
        return 0;
      }
      mergedIO.stderr?.(`Unknown pairing command: ${subcommand ?? '(missing)'}\n`);
      return 1;
    }

    if (command === 'heartbeats') {
      const [subcommand] = commandArgs;
      if (subcommand === 'list') {
        const config = await selectedConfig(selectedConfigPath);
        mergedIO.stdout?.(await listHeartbeats({ storePath: config.heartbeat.storePath }));
        return 0;
      }
      mergedIO.stderr?.(`Unknown heartbeats command: ${subcommand ?? '(missing)'}\n`);
      return 1;
    }

    if (command === 'help') {
      mergedIO.stdout?.(helpText());
      return 0;
    }

    mergedIO.stderr?.(`Unknown command: ${command}\n\n${helpText()}`);
    return 1;
  } catch (error) {
    mergedIO.stderr?.(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

if (require.main === module) {
  void main();
}
