// The composition root imports MODULE BARRELS, never a module's private files. The one deliberate
// exception is `./runtime/adapters/directory-lease` below: concrete adapters are intentionally not
// re-exported from the runtime barrel, so that choosing a real lease implementation stays visible here
// rather than disappearing behind an import.
import {
  InstallationService,
  ConsoleDiagnosticSink,
  composeOwnerAuthority,
  describeOwnershipRefusal,
  effectiveConfigFor,
  loadRuntimeConfig,
  selectConfigPath,
} from './runtime';
import type { InstallationOwnership } from './runtime';
import { DirectoryLease, describeLeaseForLocalInspection } from './runtime/adapters/directory-lease';
import { Gateway } from './gateway';
import type { GatewayAdmissionDeps } from './gateway';
import { TelegramMediaSource } from './channels';
import { Bot } from 'grammy';
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

// Global last-resort safety net. The daemon must never crash from a stray rejection/throw in an optional
// subsystem (try→catch→log→fallback→continue). Both handlers log sanitized and continue; they deliberately do
// not process.exit. Every load-bearing subsystem already wraps its own errors and degrades, so an error
// reaching here is a bug worth logging, not a reason to take the daemon down. The synchronous-fatal startup
// path is still handled by main().catch.
//
// Returning a teardown lets tests remove the listeners against a fake target so they never leak onto the real
// process (jest installs its own handlers).
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
 * How long to keep observing for quiescence after `stop()` resolves. A resolved stop is not treated as
 * quiescence.
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
    /** Substitute external provider/media IO while keeping normal authority/Gateway/diagnostics. */
    externalIO?: Pick<GatewayAdmissionDeps, 'createProvider' | 'mediaSource'>;
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
    // Owner authority is composed here, from the identity ownership already resolved. The daemon root must gate its
    // own build APIs: without admission, a stranger's first DM would auto-pair and reach the owner's runtime.
    const diagnostics = new ConsoleDiagnosticSink();
    const authority = composeOwnerAuthority(owned.ownership, diagnostics);
    // The media source is only ever consulted AFTER admission returns `owner` (see
    // `Gateway.admitAndStage`). Nothing in the transport calls it. It is built here, at the composition
    // root, because only composition knows the bot token.
    const mediaSource = deps.externalIO?.mediaSource ?? (config.channels.telegram.enabled && config.channels.telegram.botToken
      ? new TelegramMediaSource({
        token: config.channels.telegram.botToken,
        api: new Bot(config.channels.telegram.botToken).api,
      })
      : undefined);
    const gateway = (deps.createGateway ?? ((c) => new Gateway(c, {
      admission: authority.admission,
      ownerId: authority.ownerId,
      mediaSource,
      diagnostics,
      createProvider: deps.externalIO?.createProvider,
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
            `[main] Shutdown returned while work was still in flight (turns=${inFlight.turns}, builds=${inFlight.builds}, runtimes=${inFlight.runtimes}); retaining local resource ownership. Confirm this process has exited, then remove the installation lease yourself.`,
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
