// tests/gateway/gateway-boot-sweep.test.ts
//
// The protected invariant: **the staging sweep is a BOOT responsibility and happens exactly once,
// so a mid-session promotion can never delete a file the owner is currently uploading.**
//
// Review round 2 findings 2.1/2.2. `sweepStagedMedia` lived inside `serveOwner`, which is shared by
// two callers: boot, and the unpaired -> bound promotion that fires on the first admitted owner
// message. That placement is the defect, and this module's own README already said so —
// "sweepStagedMedia is exported because boot must call it, and boot is the only safe moment".
//
// Two concrete consequences of the old placement, both reproduced here through real modules:
//
//   1. `unpairedOnly` is cleared only at the very END of `serveOwner`. Any failure before that
//      leaves it set, so the next owner message re-enters `serveOwner` and sweeps again — this time
//      over a lane that can hold live staged media.
//   2. The sweep was never mutually exclusive with `stager.stage(...)`. Two messages interleave, so
//      one could be mid-download while the other's promotion swept the lane underneath it.
//
// The accepted S1-R-01 behaviour (a crash-left orphan is removed at restart) must SURVIVE the move,
// so it is asserted here too — at boot, which is where it belongs.

import * as fs from 'fs';
import * as path from 'path';

import { Gateway } from '../../src/gateway/gateway';
import { CryptoPairingCodePort, FileOwnerStatePort } from '../../src/runtime/adapters';
import { OwnerAdmissionService, asProfileId } from '../../src/profiles';
import type { Clock } from '../../src/ports/clock';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';

class FixedClock implements Clock {
  constructor(private instant = new Date('2026-06-01T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.instant);
  }
}

describe('staging sweep is boot-only', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-boot-sweep');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  /** An unpaired-but-healthy installation, booted through the real `Gateway.start()`. */
  async function bootUnpaired(telegramEnabled = false) {
    const fixture = writeConfigFixture(root, { telegramEnabled });
    const admission = new OwnerAdmissionService({
      store: new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId),
      codes: new CryptoPairingCodePort(),
      clock: new FixedClock(),
      expectedOwnerId: fixture.ownerId,
    });
    await admission.initialize();
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    const { loadRuntimeConfig } = await import('../../src/runtime/startup');
    const loaded = await loadRuntimeConfig({ configPath: fixture.configPath });
    const gateway = new Gateway(loaded, { admission, ownerId: asProfileId(fixture.ownerId)! });
    // Boot for real. Without this the gateway is inert: no sweep, no admission, no promotion — and
    // every assertion below would pass for the wrong reason.
    await gateway.start();
    return { fixture, gateway, plaintext: issued.plaintext };
  }

  /** Pair the owner through the real admission path, then trigger the real promotion. */
  async function pairAndPromote(
    gateway: Gateway,
    plaintext: string,
  ): Promise<void> {
    const paired = await gateway.handleTestMessage('local-chat', plaintext, 'e-pair');
    expect(paired).toMatch(/pairing complete/i);
    // The promotion runs on the NEXT admitted owner message.
    await gateway.handleTestMessage('local-chat', 'hello, I am back', 'e-promote');
  }

  it('removes a crash-left orphan at BOOT (S1-R-01 survives the move)', async () => {
    // Seed what a hard crash leaves behind, BEFORE the process exists.
    fs.mkdirSync(fixtureStaging(root), { recursive: true, mode: 0o700 });
    const orphan = path.join(fixtureStaging(root), 'crash-left.pdf');
    fs.writeFileSync(orphan, 'partial bytes', { mode: 0o600 });
    expect(fs.existsSync(orphan)).toBe(true);

    const { gateway } = await bootUnpaired();
    try {
      // Swept during start(), with no promotion involved at all.
      expect(fs.existsSync(orphan)).toBe(false);
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it('a live file in the staging lane SURVIVES the pairing promotion', async () => {
    const { gateway, plaintext } = await bootUnpaired();
    try {
      // Written AFTER boot, standing in for an upload the owner is in the middle of. An unpaired
      // daemon refuses media, so this is placed directly in the lane rather than driven through a
      // transport — what is under test is the promotion's behaviour toward the lane, not intake.
      fs.mkdirSync(fixtureStaging(root), { recursive: true, mode: 0o700 });
      const live = path.join(fixtureStaging(root), 'live-in-flight.pdf');
      fs.writeFileSync(live, 'bytes the owner is uploading', { mode: 0o600 });

      await pairAndPromote(gateway, plaintext);

      // Before the fix the promotion re-entered `serveOwner` and swept, deleting exactly this file.
      expect(fs.existsSync(live)).toBe(true);
      expect(fs.readFileSync(live, 'utf8')).toBe('bytes the owner is uploading');
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it('still refuses to build a clinical runtime before pairing', async () => {
    // Guards against the sweep move being "fixed" by simply deleting the sweep: the unpaired boot
    // still has to be clinically empty.
    const { gateway } = await bootUnpaired();
    try {
      expect(gateway.servesPairingOnly).toBe(true);
      expect(gateway.runtimeInstance).toBeUndefined();
      expect(gateway.runtimeManager).toBeUndefined();
    } finally {
      await gateway.stop();
    }
  }, 60_000);
});

/** The single owner's staging lane for the default fixture owner. */
function fixtureStaging(root: string): string {
  return path.join(root, 'state', 'profiles', 'owner', '.state', 'media-staging');
}