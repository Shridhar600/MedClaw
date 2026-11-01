
import * as fs from 'fs';
import * as path from 'path';

import { Gateway } from '../../src/gateway/gateway';
import { CryptoPairingCodePort, FileOwnerStatePort } from '../../src/runtime/adapters';
import { OwnerAdmissionService, asProfileId } from '../../src/profiles';
import type { OwnerStatePort } from '../../src/ports/owner-state';
import type { Clock } from '../../src/ports/clock';
import type { DiagnosticEvent } from '../../src/ports/diagnostics';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';

class FixedClock implements Clock {
  constructor(private instant = new Date('2026-06-01T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.instant);
  }
}

describe('unpaired daemon boot', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('unpaired-boot');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('builds no clinical runtime and serves pairing only', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false });
    const store = new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId);
    const clock = new FixedClock();
    const admission = new OwnerAdmissionService({
      store,
      codes: new CryptoPairingCodePort(),
      clock,
      expectedOwnerId: fixture.ownerId,
    });
    await admission.initialize();
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    const { loadRuntimeConfig } = await import('../../src/runtime/startup');
    const loaded = await loadRuntimeConfig({ configPath: fixture.configPath });

    const gateway = new Gateway(loaded, { admission, ownerId: asProfileId(fixture.ownerId)! });
    await gateway.start();

    try {
      expect(gateway.servesPairingOnly).toBe(true);
      expect(gateway.runtimeInstance).toBeUndefined();
      expect(gateway.runtimeManager).toBeUndefined();
      expect(fs.readdirSync(fixture.workspace)).toEqual(['.state']);
      expect(fs.readdirSync(path.join(fixture.workspace, '.state'))).toEqual(['owner-access.json']);

      const prompt = await gateway.handleTestMessage('local-chat', 'hello?', 'm1');
      expect(prompt).toMatch(/pairing code/i);

      const paired = await gateway.handleTestMessage('local-chat', issued.plaintext, 'm2');
      expect(paired).toMatch(/pairing complete/i);
      expect(gateway.runtimeInstance).toBeUndefined();
      expect(gateway.runtimeManager).toBeUndefined();
      expect(gateway.getShutdownDisposition()).toBe('quiescent');
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it('refuses a missing owner record with one terminal boot result', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false });
    const store: OwnerStatePort = new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId);
    const admission = new OwnerAdmissionService({
      store,
      codes: new CryptoPairingCodePort(),
      clock: new FixedClock(),
      expectedOwnerId: fixture.ownerId,
    });

    const { loadRuntimeConfig } = await import('../../src/runtime/startup');
    const loaded = await loadRuntimeConfig({ configPath: fixture.configPath });
    const events: DiagnosticEvent[] = [];
    const gateway = new Gateway(loaded, { admission, ownerId: asProfileId(fixture.ownerId)!, diagnostics: { emit: event => { events.push(event); } } });

    await expect(gateway.start()).rejects.toThrow(/Refusing to serve.*unavailable.*Re-run setup/is);
    expect(gateway.runtimeInstance).toBeUndefined();
    expect(events.filter(event => event.stage === 'start-stop')).toEqual([
      expect.objectContaining({ outcome: 'refused', reason: 'admission-refused' }),
    ]);
  }, 60_000);

  it('refuses to boot when the record on disk belongs to another owner', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false, ownerId: 'alpha' });
    fs.mkdirSync(path.dirname(fixture.ownerRecord), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      fixture.ownerRecord,
      `${JSON.stringify({
        version: 1,
        ownerId: 'beta',
        createdAt: new Date('2026-06-01T12:00:00.000Z').toISOString(),
        phase: 'unpaired',
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const store = new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId);
    const admission = new OwnerAdmissionService({
      store,
      codes: new CryptoPairingCodePort(),
      clock: new FixedClock(),
      expectedOwnerId: fixture.ownerId,
    });

    const { loadRuntimeConfig } = await import('../../src/runtime/startup');
    const loaded = await loadRuntimeConfig({ configPath: fixture.configPath });
    const gateway = new Gateway(loaded, { admission, ownerId: asProfileId(fixture.ownerId)! });

    await expect(gateway.start()).rejects.toThrow(/Refusing to serve.*owner-mismatch/is);
  }, 60_000);
});
