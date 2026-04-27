import { Gateway } from './gateway/gateway';
import { loadRuntimeConfig } from './runtime/startup';

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

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error('[main] Fatal error:', message);
  process.exit(1);
});
