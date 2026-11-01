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

async function selectedConfig(resolvedConfigPath: string) {
  return loadRuntimeConfig({ configPath: resolvedConfigPath });
}

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const mergedIO = { ...defaultIO(), ...io };

  let selectedConfigPath: string;
  let command: string | undefined;
  let commandArgs: string[];
  try {
    const { configPath, rest, help } = parseGlobalOptions(argv);

    if (help || rest.length === 0) {
      mergedIO.stdout?.(helpText());
      return 0;
    }

    selectedConfigPath = selectConfigPath({ flagValue: configPath });

    [command, ...commandArgs] = rest;

    if (command !== 'onboard' && command !== 'init' && command !== 'config') {
      const stray = commandArgs.find((token) => token.startsWith('-'));
      if (stray !== undefined) {
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
