import { Gateway } from './gateway/gateway';
import { loadRuntimeConfig } from './runtime/startup';
import { summarizeErrorForLog } from './security';

// Minimal event-target surface needed so the safety net can be installed and
// torn down against either the real `process` or a test fake EventEmitter.
type SafetyNetTarget = {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  on(event: 'uncaughtException', listener: (error: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'uncaughtException', listener: (error: unknown) => void): void;
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

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const gateway = new Gateway(config);

  await gateway.start();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[main] SIGTERM received, shutting down...');
    await gateway.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[main] SIGINT received, shutting down...');
    await gateway.stop();
    process.exit(0);
  });
}

// Entry-only side effects. Gated so importing this module (e.g. in a jest
// test exercising installGlobalSafetyNet) does NOT bootstrap the gateway.
// `require.main === module` is verified to be true under `node --import tsx
// src/index.ts` (the production launcher) and false under jest/ts-jest import.
if (require.main === module) {
  installGlobalSafetyNet();
  main().catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[main] Fatal error:', message);
    process.exit(1);
  });
}