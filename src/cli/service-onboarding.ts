// src/cli/service-onboarding.ts
//
// The setup ENTRY point: validate the arguments, hand the owner off to the wizard when
// interactive, apply the artifacts when not, and run the chosen completion action.
//
// Argument parsing and configuration/artifact building moved to `./setup-config` so that this
// module and `./setup-wizard` no longer import each other (plan 15 §2.4).

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
  isSupportedOnboardingProvider,
  parseArgs,
  persistSetupArtifacts,
  resolveNonInteractiveArgs,
  resolveSetupValues,
  SUPPORTED_ONBOARDING_PROVIDERS,
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
        // forka #9: the daemon is detached (its own process group), so Ctrl-C in
        // this wizard does NOT stop it. Write a pid file next to the config and
        // tell the user exactly how to stop it, so a detached start is not a
        // surprise.
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
    const args = parseArgs(argv);
    if (args.provider && !isSupportedOnboardingProvider(args.provider)) {
      io.stderr?.(
        `Unsupported onboard provider: ${args.provider}. Supported choices: ${SUPPORTED_ONBOARDING_PROVIDERS.join(', ')}.\n`,
      );
      return 1;
    }

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
