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

/**
 * Name a token for an error message WITHOUT echoing a possible value: `--name=value` reports
 * `--name`, a long option reports itself, and anything else becomes a placeholder. This keeps a
 * pasted secret off stderr in every refusal in this file.
 */
function reportToken(token: string | undefined, placeholder: string): string {
  if (token === undefined) return placeholder;
  if (!token.startsWith('--')) return placeholder;
  return token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
}

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
    '  onboard                  (alias: init)',
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
    '',
    'Run `medclaw onboard --help` for the setup options, including the independent',
    'main, medical and embedding provider selections.',
  ].join('\n') + '\n';
}

/**
 * Load the already-resolved selected configuration. Refuses when the document is unavailable, so no
 * inspection command can fall back to a default identity or report a healthy-empty result. Takes an
 * absolute, already-selected path; selection happens once, in `runCli`.
 */
async function selectedConfig(resolvedConfigPath: string) {
  return loadRuntimeConfig({ configPath: resolvedConfigPath });
}

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const mergedIO = { ...defaultIO(), ...io };

  // Global parsing THROWS on an unknown option or a missing `--config` value, so parsing and
  // selection stay inside the guarded region: both refusals return exit code 1 with a message.
  let selectedConfigPath: string;
  let command: string | undefined;
  let commandArgs: string[];
  try {
    const { configPath, rest, help } = parseGlobalOptions(argv);

    if (help || rest.length === 0) {
      mergedIO.stdout?.(helpText());
      return 0;
    }

    // The single point where configuration selection happens:
    // `--config > REDACTED_CONFIG_PATH > ~/.redacted/config.json`. It is resolved once here and
    // passed down explicitly as a required path, so every command reads the same installation the
    // daemon serves. `selectConfigPath` also validates a present-but-empty `--config` and resolves
    // relative values against the cwd.
    selectedConfigPath = selectConfigPath({ flagValue: configPath });

    [command, ...commandArgs] = rest;

    // Global option parsing stops at the command, so `onboard --yes --owner-id kiran` reaches that
    // command's own parser. A command that declares no options of its own must still refuse a stray
    // flag rather than silently ignore it (`status --bogus`), so the refusal lives here instead.
    if (command !== 'onboard' && command !== 'init' && command !== 'config') {
      const stray = commandArgs.find((token) => token.startsWith('-'));
      if (stray !== undefined) {
        // Name only, and only for long options: `status --api-key=sk-...` must not echo the value,
        // and a non-option-shaped token is not an option name at all.
        const name = !stray.startsWith('--')
          ? '(option-shaped token)'
          : (stray.includes('=') ? stray.slice(0, stray.indexOf('=')) : stray);
        mergedIO.stderr?.(`Unknown option for \`${command}\`: ${name}. Run \`medclaw ${command} --help\`.\n`);
        return 1;
      }
    }
  } catch (error) {
    mergedIO.stderr?.(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
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
        if (configKey.startsWith('-')) {
          // A dotted configuration path never starts with '-'. Refusing here (rather than letting
          // `setConfigValue` report it) keeps a pasted `--api-key=sk-...` out of the admin reader
          // AND out of the decoder's issue text, both of which name the supplied path.
          mergedIO.stderr?.(
            `Unknown config path: ${reportToken(configKey, '(option-shaped token)')}.`
            + ' Usage: config set <path> <value>\n',
          );
          return 1;
        }
        const value = valueParts.join(' ');
        mergedIO.stdout?.(
          await setConfigValue(selectedConfigPath, configKey, value),
        );
        return 0;
      }
      mergedIO.stderr?.(`Unknown config command: ${reportToken(subcommand, '(missing)')}\n`);
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
        mergedIO.stdout?.(await listHeartbeats({ configPath: selectedConfigPath }));
        return 0;
      }
      mergedIO.stderr?.(`Unknown heartbeats command: ${subcommand ?? '(missing)'}\n`);
      return 1;
    }

    if (command === 'help') {
      mergedIO.stdout?.(helpText());
      return 0;
    }

    // A command name is normally echoed so the operator sees the typo. An option-shaped first token
    // (reached via `medclaw -- --api-key=...`) may be a pasted secret, so only its name is reported.
    const reportedCommand = command.startsWith('-')
      ? (command.includes('=') ? command.slice(0, command.indexOf('=')) : '(option-shaped token)')
      : command;
    mergedIO.stderr?.(`Unknown command: ${reportedCommand}\n\n${helpText()}`);
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
