import * as fs from 'fs';
import { InstallationService } from '../../src/runtime/installation';
import { DirectoryLease } from '../../src/runtime/adapters/directory-lease';

const [, , label, configPath, barrierFile, leaseTimeoutMs] = process.argv;
const timeout = Number(leaseTimeoutMs ?? 20_000);

const deadline = Date.now() + timeout;
while (Date.now() < deadline) {
  try {
    if (fs.readFileSync(barrierFile, 'utf8').length > 0) break;
  } catch { /* ignore */ }
  const until = Date.now() + 2;
  while (Date.now() < until) {
    /* spin so contenders are not serialised on the event loop */
  }
}

async function main(): Promise<void> {
  const services = new InstallationService(new DirectoryLease());
  let result: Record<string, unknown>;
  try {
    const owned = await services.acquireOwnership(configPath, process.env.HOME ?? '/tmp');
    if (owned.kind === 'owned') {
      result = { label, outcome: 'owned' };
      const releaseMarker = process.env.TEST_RELEASE_MARKER ?? '';
      const releaseDeadline = Date.now() + timeout;
      while (releaseMarker !== '' && Date.now() < releaseDeadline) {
        try {
          if (fs.readFileSync(releaseMarker, 'utf8').length > 0) break;
        } catch {
          /* not created yet */
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      await owned.ownership.release();
    } else if (owned.kind === 'busy') {
      result = { label, outcome: 'busy', resource: owned.resource, reason: owned.lease.reason };
    } else if (owned.kind === 'unavailable') {
      result = { label, outcome: 'unavailable', resource: owned.resource, reason: owned.reason };
    } else {
      result = { label, outcome: 'invalid-config' };
    }
  } catch (error) {
    result = { label, outcome: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
