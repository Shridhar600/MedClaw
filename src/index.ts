import { loadConfig } from './config/config';
import { Gateway } from './gateway/gateway';

async function main(): Promise<void> {
  const config = await loadConfig();
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
  console.error('[main] Fatal error:', e);
  process.exit(1);
});