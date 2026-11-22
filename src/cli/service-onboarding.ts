
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type SpawnOptions } from 'child_process';
import { effectiveConfigFor, readConfigDocument } from '../runtime';
import { showConfig, showRedactedConfigSummary } from './admin';
import type { CliIO } from './prompts';
import { preflightStartCheck, type SetupReadinessDependencies } from './setup-readiness';
import type { CompletionAction } from './wizard-types';
import {
  buildConfigFromArgs,
  collectSetupErrors,
  createInitialWizardState,
  ONBOARD_HELP_TEXT,
  parseArgs,
  persistSetupArtifacts,
  requireOptionValue,
  resolveNonInteractiveArgs,
  resolveSetupValues,
} from './setup-config';

export {
  DEFAULT_SETUP_OWNER_ID,
  SUPPORTED_ONBOARDING_PROVIDERS,
  isSupportedOnboardingProvider,
} from './setup-config';
export type { ServiceOnboardingArgs } from './setup-config';

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
    const config = effectiveConfigFor(readConfigDocument(configPath, os.homedir()).stored);
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
    const hasLeadingConfigPair = argv[0] === '--config';
    if (hasLeadingConfigPair) {
      requireOptionValue('--config', argv[1]);
    }
    const operatorArgs = hasLeadingConfigPair ? argv.slice(2) : argv;
    if (operatorArgs[0] === '--help' || operatorArgs[0] === '-h') {
      io.stdout?.(ONBOARD_HELP_TEXT);
      return 0;
    }

    const args = parseArgs(argv);

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
