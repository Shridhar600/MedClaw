import { Gateway } from './gateway/gateway';
import { loadRuntimeConfig, selectConfigPath } from './runtime/startup';
import {
  InstallationService,
  describeOwnershipRefusal,
  effectiveConfigFor,
} from './runtime/installation';
import { DirectoryLease, describeLeaseForLocalInspection } from './runtime/adapters/directory-lease';
import { composeOwnerAuthority } from './runtime/owner-authority';
import { TelegramMediaSource } from './channels/telegram-media-source';
import { Bot } from 'grammy';
import type { InstallationOwnership } from './runtime/installation';
import { summarizeErrorForLog } from './security';
import * as os from 'os';

// Minimal event-target surface needed so the safety net can be installed and
// torn down against either the real `process` or a test fake EventEmitter.
type SafetyNetTarget = {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  on(event: 'uncaughtException', listener: (error: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'uncaughtException', listener: (error: unknown) => void): void;
};

type SignalTarget = {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  off(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
};

// Global last-resort safety net (RES-P1-3). The daemon MUST NEVER crash from a
// stray rejection/throw in an optional subsystem (resilience law:
// try→catch→log→fallback→continue). Both handlers log sanitized and CONTINUE;
// they deliberately do NOT process.exit. Every load-bearing subsystem (telegram,
// scheduler, store, gateway) already wraps its own errors and degrades, so an
// error reaching here is a bug worth logging, not a reason to take the daemon
// down. The synchronous-fatal startup path is still handled by main().catch.
//
// Returning a teardown lets tests remove the listeners against a fake target so
// they never leak onto the real process (jest installs its own handlers).
export function installGlobalSafetyNet(target: SafetyNetTarget = process as unknown as SafetyNetTarget): () => void {
  const onUnhandled = (reason: unknown): void => {
    console.error('[main] Unhandled rejection (continuing):', summarizeErrorForLog(reason));
  };
  const onUncaught = (err: unknown): void => {
    console.error('[main] Uncaught exception (continuing):', summarizeErrorForLog(err));
  };
  target.on('unhandledRejection', onUnhandled);
  target.on('uncaughtException', onUncaught);
  return () => {
    target.off('unhandledRejection', onUnhandled);
    target.off('uncaughtException', onUncaught);
  };
}

export function reportFatalStartupError(error: unknown): void {
  console.error('[main] Fatal error:', summarizeErrorForLog(error));
  console.error('[main] If configuration is missing, run `npm run cli -- onboard`.');
  process.exit(1);
}

/**
 * How long to keep observing for quiescence after `stop()` resolves.
 *
 * S1 owns only the narrow release guard: stop is not treated as quiescence. Bounded pending
 * construction cancellation and one shared stop deadline are S5.
 */
export const QUIESCENCE_OBSERVE_MS = 250;

export interface DaemonHandle {
  /** Always `owned`; a refused boot throws instead of returning a handle. */
  kind: 'owned';
  gateway: Gateway;
  ownership: InstallationOwnership;
  /** Stop, then release ownership only once the daemon is quiescent. */
  shutdown(): Promise<void>;
}

/**
 * Boot the daemon: read the configuration, take ownership of the selected config resource and
 * the selected owner workspace, then start the Gateway.
 *
 * Refuses when another local process already owns either resource. Two daemons can never both
 * serve one owner.
 */
export async function startDaemon(
  deps: {
    services?: InstallationService;
    createGateway?: (config: Awaited<ReturnType<typeof loadRuntimeConfig>>) => Gateway;
    homeDir?: string;
    configPath?: string;
  } = {},
): Promise<DaemonHandle> {
  const services = deps.services ?? new InstallationService(new DirectoryLease());
  const homeDir = deps.homeDir ?? os.homedir();
  const configPath = deps.configPath ?? selectConfigPath({ homeDir });

  const owned = await services.acquireOwnership(configPath, homeDir);
  if (owned.kind !== 'owned') {
    throw new Error(describeOwnershipRefusal(owned));
  }

  try {
    const config = effectiveConfigFor(owned.ownership.stored);
    // Owner authority is composed HERE, from the identity ownership already resolved. Before this,
    // the production boot built a Gateway with no admission at all, so the S1 refusal policy and the
    // unpaired-only boot rule never ran on a real daemon: a stranger's first DM still auto-paired and
    // reached the owner's runtime. Plan 15 §5 requires the daemon root to gate its own build APIs.
    const authority = composeOwnerAuthority(owned.ownership);
    // The media source is only ever consulted AFTER admission returns `owner` (see
    // `Gateway.admitAndStage`). Nothing in the transport calls it. It is built here, at the composition
    // root, because only composition knows the bot token.
    const mediaSource = config.channels.telegram.enabled && config.channels.telegram.botToken
      ? new TelegramMediaSource({
        token: config.channels.telegram.botToken,
        api: new Bot(config.channels.telegram.botToken).api,
      })
      : undefined;
    const gateway = (deps.createGateway ?? ((c) => new Gateway(c, {
      admission: authority.admission,
      ownerId: authority.ownerId,
      mediaSource,
    })))(config);
    await gateway.start();

    return {
      kind: 'owned',
      gateway,
      ownership: owned.ownership,
      shutdown: async (): Promise<void> => {
        await gateway.stop();
        // A stop that returned after a timeout is NOT quiescence. Ownership is retained and the
        // operator is told, rather than a second daemon being allowed to enter.
        const deadline = Date.now() + QUIESCENCE_OBSERVE_MS;
        while (gateway.getShutdownDisposition() === 'pending' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const disposition = gateway.getShutdownDisposition();
        if (disposition === 'pending') {
          const inFlight = gateway.shutdownWorkInFlight();
          console.warn(
            `[main] Shutdown returned while work was still in flight (turns=${inFlight.turns}, builds=${inFlight.builds}); retaining local resource ownership. Confirm this process has exited, then remove the installation lease yourself.`,
          );
          return;
        }
        await owned.ownership.release();
      },
    };
  } catch (error) {
    // A failed start with uncertain partial work retains ownership; it is not silently released.
    console.warn('[main] Startup failed; local resource ownership is retained for inspection.');
    throw error;
  }
}

/** Wire signal handlers against an injectable target so tests never signal a real process. */
export function installShutdownHandlers(handle: DaemonHandle, target: SignalTarget = process): () => void {
  let shuttingDown = false;
  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[main] Shutdown signal received...');
    void handle.shutdown()
      .catch((error: unknown) => {
        console.warn('[main] Shutdown did not complete cleanly:', summarizeErrorForLog(error));
      })
      .finally(() => {
        process.exit(0);
      });
  };
  target.on('SIGTERM', onSignal);
  target.on('SIGINT', onSignal);
  return () => {
    target.off('SIGTERM', onSignal);
    target.off('SIGINT', onSignal);
  };
}

/** Local operator inspection of a lease: resource kind and recorded pid, never the path. */
export function inspectLease(configPath: string): ReturnType<typeof describeLeaseForLocalInspection> {
  return describeLeaseForLocalInspection(configPath);
}

async function main(): Promise<void> {
  const handle = await startDaemon();
  installShutdownHandlers(handle);
}

// Entry-only side effects. Gated so importing this module (e.g. in a jest
// test exercising installGlobalSafetyNet) does NOT bootstrap the gateway.
// `require.main === module` is verified to be true under `node --import tsx
// src/index.ts` (the production launcher) and false under jest/ts-jest import.
if (require.main === module) {
  installGlobalSafetyNet();
  main().catch(reportFatalStartupError);
}
