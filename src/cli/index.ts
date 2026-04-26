import * as path from 'path';
import { loadConfig } from '../config/config';
import { listHeartbeats, setConfigValue, showConfig, showProfile, showStatus, showUserSummary } from './admin';
import { runServiceOnboarding } from './service-onboarding';
import type { CliIO } from './prompts';

export interface CliRunResult {
  code: number;
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
    '  onboard',
    '  init (alias for onboard)',
    '  status',
    '  config show',
    '  config set <path> <value>',
    '  profile show',
    '  user summary',
    '  heartbeats list',
    '',
    'Global options:',
    '  --help',
    '  --config <path>',
  ].join('\n') + '\n';
}

function parseGlobalOptions(argv: string[]): { configPath?: string; rest: string[]; help: boolean } {
  const rest: string[] = [];
  let configPath: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h' || token === 'help') {
      help = true;
      continue;
    }
    if (token === '--config') {
      configPath = argv[index + 1];
      index += 1;
      continue;
    }
    rest.push(token);
  }

  return { configPath, rest, help };
}

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const mergedIO = { ...defaultIO(), ...io };
  const { configPath, rest, help } = parseGlobalOptions(argv);

  if (help || rest.length === 0) {
    mergedIO.stdout?.(helpText());
    return 0;
  }

  const [command, ...commandArgs] = rest;

  try {
    if (command === 'init' || command === 'onboard') {
      return await runServiceOnboarding(
        commandArgs.includes('--config') ? commandArgs : ['--config', configPath ?? path.join(process.env.HOME ?? '', '.redacted', 'config.json'), ...commandArgs],
        mergedIO,
      );
    }

    if (command === 'status') {
      mergedIO.stdout?.(await showStatus({ configPath }));
      return 0;
    }

    if (command === 'config') {
      const [subcommand, ...subArgs] = commandArgs;
      if (subcommand === 'show') {
        mergedIO.stdout?.(await showConfig({ configPath }));
        return 0;
      }
      if (subcommand === 'set') {
        const [configKey, ...valueParts] = subArgs;
        if (!configKey || valueParts.length === 0) {
          mergedIO.stderr?.('Usage: config set <path> <value>\n');
          return 1;
        }
        const value = valueParts.join(' ');
        mergedIO.stdout?.(await setConfigValue(configPath ?? path.join(process.env.HOME ?? '', '.redacted', 'config.json'), configKey, value));
        return 0;
      }
      mergedIO.stderr?.(`Unknown config command: ${subcommand ?? '(missing)'}\n`);
      return 1;
    }

    if (command === 'profile') {
      const [subcommand] = commandArgs;
      if (subcommand === 'show') {
        const config = await loadConfig({ configPath });
        mergedIO.stdout?.(await showProfile({ configPath, workspacePath: config.memory.workspace }));
        return 0;
      }
      mergedIO.stderr?.(`Unknown profile command: ${subcommand ?? '(missing)'}\n`);
      return 1;
    }

    if (command === 'user') {
      const [subcommand] = commandArgs;
      if (subcommand === 'summary') {
        const config = await loadConfig({ configPath });
        mergedIO.stdout?.(await showUserSummary({ configPath, workspacePath: config.memory.workspace }));
        return 0;
      }
      mergedIO.stderr?.(`Unknown user command: ${subcommand ?? '(missing)'}\n`);
      return 1;
    }

    if (command === 'heartbeats') {
      const [subcommand] = commandArgs;
      if (subcommand === 'list') {
        const config = await loadConfig({ configPath });
        mergedIO.stdout?.(await listHeartbeats({ configPath, storePath: config.heartbeat.storePath }));
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
