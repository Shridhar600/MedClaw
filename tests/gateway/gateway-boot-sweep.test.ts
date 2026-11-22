
import * as fs from 'fs';
import fsModule from 'fs';
import * as path from 'path';

import { Gateway } from '../../src/gateway';
import { CryptoPairingCodePort, FileOwnerStatePort, loadRuntimeConfig } from '../../src/runtime';
import { OwnerAdmissionService, asProfileId } from '../../src/profiles';
import type { Clock } from '../../src/ports/clock';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture, type ConfigFixture } from '../helpers/config-fixture';
import { stageMediaFixture } from '../helpers/media-artifact-fixture';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';

class FixedClock implements Clock {
  constructor(private instant = new Date('2026-06-01T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.instant);
  }
}

describe('staging sweep is boot-only', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('boot-sweep');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    removeTestTemp(root);
  });

  /** An unpaired-but-healthy installation, booted through the real `Gateway.start()`. */
  async function bootUnpaired(telegramEnabled = false, beforeBoot?: (fixture: ConfigFixture) => Promise<void> | void) {
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

    const loaded = await loadRuntimeConfig({ configPath: fixture.configPath });
    const gateway = new Gateway(loaded, { admission, ownerId: asProfileId(fixture.ownerId)!,
      createProvider: (): LLMProvider => ({ modelName: 'offline-boot-fixture',
        chat: async (): Promise<LLMResponse> => ({ type: 'text', text: 'Owner text served.' }),
        embed: async (): Promise<number[]> => new Array(768).fill(0),
      }),
    });
    await beforeBoot?.(fixture);
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
    await gateway.handleTestMessage('local-chat', 'hello, I am back', 'e-promote');
  }

  it('removes a crash-left orphan at BOOT', async () => {
    fs.mkdirSync(fixtureStaging(root), { recursive: true, mode: 0o700 });
    const orphan = await stageMediaFixture(root, fixtureStaging(root), 'partial bytes');
    expect(fs.existsSync(orphan)).toBe(true);

    const { gateway } = await bootUnpaired();
    try {
      expect(fs.existsSync(orphan)).toBe(false);
      expect(gateway.stagingCleanupResult).toEqual({ kind: 'complete', inspected: 1, removed: 1 });
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it('a live file in the staging lane SURVIVES the pairing promotion', async () => {
    const { gateway, plaintext } = await bootUnpaired();
    try {
      fs.mkdirSync(fixtureStaging(root), { recursive: true, mode: 0o700 });
      const live = await stageMediaFixture(root, fixtureStaging(root), 'bytes the owner is uploading');

      await pairAndPromote(gateway, plaintext);

      expect(fs.existsSync(live)).toBe(true);
      expect(fs.readFileSync(live, 'utf8')).toBe('bytes the owner is uploading');
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it('still refuses to build a clinical runtime before pairing', async () => {
    const { gateway } = await bootUnpaired();
    try {
      expect(gateway.servesPairingOnly).toBe(true);
      expect(gateway.runtimeInstance).toBeUndefined();
      expect(gateway.runtimeManager).toBeUndefined();
      expect(gateway.stagingCleanupResult).toEqual({ kind: 'complete', inspected: 0, removed: 0 });
      expect(fs.existsSync(fixtureStaging(root))).toBe(false);
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it('unrelated entries consume the boot budget; partial reaches the consumer, text works and promotion does not resweep', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reads: string[] = [];
    let readCalls = 0;
    let closes = 0;
    const open = fsModule.opendirSync;
    const directories: fs.Dir[] = [];
    jest.spyOn(fsModule, 'opendirSync').mockImplementation((target, options) => {
      const directory = open(target, options);
      directories.push(directory);
      const read = directory.readSync.bind(directory);
      const close = directory.closeSync.bind(directory);
      jest.spyOn(directory, 'readSync').mockImplementation(() => {
        readCalls += 1;
        const entry = read();
        if (entry) reads.push(entry.name);
        return entry;
      });
      jest.spyOn(directory, 'closeSync').mockImplementation(() => { closes += 1; close(); });
      return directory;
    });
    const preserved: string[] = [];
    const artifacts: string[] = [];
    const { fixture, gateway, plaintext } = await bootUnpaired(false, async fixture => {
      artifacts.push(await stageMediaFixture(fixture.workspace, fixture.mediaStaging, 'abandoned final'));
      const staged = await stageMediaFixture(fixture.workspace, fixture.mediaStaging, 'abandoned partial');
      fs.renameSync(staged, `${staged}.part`);
      artifacts.push(`${staged}.part`);
      const target = path.join(root, 'outside-sentinel');
      fs.writeFileSync(target, 'outside bytes', { mode: 0o600 });
      for (let i = 0; i < 255; i += 1) {
        const entry = path.join(fixture.mediaStaging, `unrelated-${i}`);
        if (i % 3 === 0) fs.writeFileSync(entry, 'unrelated bytes', { mode: 0o600 });
        else if (i % 3 === 1) fs.mkdirSync(entry, { mode: 0o700 });
        else fs.symlinkSync(target, entry);
        preserved.push(entry);
      }
    });
    try {
      const removed = artifacts.filter(artifact => reads.includes(path.basename(artifact))).length;
      expect(gateway.stagingCleanupResult).toEqual({ kind: 'partial', inspected: 256, removed, reason: 'entry-limit' });
      expect(readCalls).toBe(256);
      expect(reads).toHaveLength(256);
      expect(reads.filter(name => name.startsWith('unrelated-')).length).toBeGreaterThanOrEqual(254);
      expect(closes).toBe(1);
      expect(() => fs.Dir.prototype.readSync.call(directories[0])).toThrow(/closed/i);
      for (const entry of preserved) expect(fs.lstatSync(entry)).toBeDefined();
      const binding = fs.readFileSync(fixture.ownerRecord);
      const live = await stageMediaFixture(fixture.workspace, fixture.mediaStaging, 'live after partial boot');
      await pairAndPromote(gateway, plaintext);
      await gateway.handleTestMessage('local-chat', 'skip', 'text-skip');
      expect(await gateway.handleTestMessage('local-chat', 'hello again', 'text-after-partial')).toContain('Owner text served.');
      expect(fs.readFileSync(live, 'utf8')).toBe('live after partial boot');
      expect(gateway.stagingCleanupResult).toEqual({ kind: 'partial', inspected: 256, removed, reason: 'entry-limit' });
      expect(fs.readFileSync(fixture.ownerRecord)).not.toEqual(binding);
      expect(gateway.servesPairingOnly).toBe(false);
      expect(warn.mock.calls.flat().filter(line => String(line).includes('Media staging cleanup')))
        .toEqual([`[gateway] Media staging cleanup partial: reason=entry-limit inspected=256 removed=${removed}`]);
      expect(fs.readFileSync(path.join(root, 'outside-sentinel'), 'utf8')).toBe('outside bytes');
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it('an unsafe boot lane is unavailable, remains untouched through usable text, and a later safe boot revisits artifacts', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { mode: 0o750 });
    fs.chmodSync(outside, 0o750); // Synthetic outside permission fixture.
    const sentinel = path.join(outside, 'sentinel');
    fs.writeFileSync(sentinel, 'outside bytes', { mode: 0o600 });
    const { fixture, gateway, plaintext } = await bootUnpaired(false, fixture => {
      fs.symlinkSync(outside, fixture.mediaStaging);
    });
    try {
      expect(gateway.stagingCleanupResult).toEqual({ kind: 'unavailable', inspected: 0, removed: 0, reason: 'invalid-root' });
      expect(gateway.runtimeInstance).toBeUndefined();
      await pairAndPromote(gateway, plaintext);
      await gateway.handleTestMessage('local-chat', 'skip', 'skip-after-unavailable');
      expect(await gateway.handleTestMessage('local-chat', 'hello again', 'text-after-unavailable')).toContain('Owner text served.');
      expect(fs.readdirSync(outside)).toEqual(['sentinel']);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside bytes');
      expect(fs.statSync(outside).mode & 0o777).toBe(0o750);
      expect(warn.mock.calls.flat().filter(line => String(line).includes('Media staging cleanup')))
        .toEqual(['[gateway] Media staging cleanup unavailable: reason=invalid-root inspected=0 removed=0']);
      fs.unlinkSync(fixture.mediaStaging);
      const orphan = await stageMediaFixture(fixture.workspace, fixture.mediaStaging, 'later safe boot');
      expect(fs.readFileSync(orphan, 'utf8')).toBe('later safe boot');
      await gateway.stop();
      const loaded = await loadRuntimeConfig({ configPath: fixture.configPath });
      const admission = new OwnerAdmissionService({ store: new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId),
        codes: new CryptoPairingCodePort(), clock: new FixedClock(), expectedOwnerId: fixture.ownerId });
      const next = new Gateway(loaded, { admission, ownerId: asProfileId(fixture.ownerId)!,
        createProvider: (): LLMProvider => ({ chat: async (): Promise<LLMResponse> => ({ type: 'text', text: 'safe boot' }), embed: async (): Promise<number[]> => new Array(768).fill(0) }),
      });
      const binding = fs.readFileSync(fixture.ownerRecord);
      await next.start();
      try {
        expect(next.stagingCleanupResult).toEqual({ kind: 'complete', inspected: 1, removed: 1 });
        expect(fs.existsSync(orphan)).toBe(false);
        expect(fs.readFileSync(fixture.ownerRecord)).toEqual(binding);
      } finally { await next.stop(); }
    } finally { await gateway.stop(); }
  }, 60_000);

  it.each(['read', 'stat', 'unlink', 'close'] as const)('an actual %s IO failure after opening produces partial and closes the directory', async (fault) => {
    let artifact = '';
    let directory: fs.Dir | undefined;
    const open = fsModule.opendirSync;
    const stat = fsModule.lstatSync;
    const unlink = fsModule.unlinkSync;
    const failure = (): Error & { code: string } => Object.assign(new Error('synthetic IO failure'), { code: 'EIO' });
    let closes = 0;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { gateway } = await bootUnpaired(false, async fixture => {
      artifact = await stageMediaFixture(fixture.workspace, fixture.mediaStaging, 'abandoned bytes');
      jest.spyOn(fsModule, 'opendirSync').mockImplementation((target, options) => {
        directory = open(target, options);
        const close = directory.closeSync.bind(directory);
        if (fault === 'read') jest.spyOn(directory, 'readSync').mockImplementationOnce(() => { throw failure(); });
        jest.spyOn(directory, 'closeSync').mockImplementation(() => { closes += 1; close(); if (fault === 'close') throw failure(); });
        return directory;
      });
      if (fault === 'stat') jest.spyOn(fsModule, 'lstatSync').mockImplementation((...args) => {
        if (String(args[0]) === artifact) throw failure();
        return Reflect.apply(stat, fsModule, args);
      });
      if (fault === 'unlink') jest.spyOn(fsModule, 'unlinkSync').mockImplementation(target => {
        if (String(target) === artifact) throw failure();
        unlink(target);
      });
    });
    try {
      expect(gateway.stagingCleanupResult).toEqual({ kind: 'partial', inspected: fault === 'read' ? 0 : 1,
        removed: fault === 'close' ? 1 : 0, reason: 'io-failed' });
      expect(closes).toBe(1);
      expect(() => directory!.readSync()).toThrow(/closed/i);
      if (fault !== 'close') expect(fs.readFileSync(artifact, 'utf8')).toBe('abandoned bytes');
      else expect(fs.existsSync(artifact)).toBe(false);
      expect(warn.mock.calls.flat().filter(line => String(line).includes('Media staging cleanup'))).toHaveLength(1);
    } finally { jest.restoreAllMocks(); await gateway.stop(); }
  }, 60_000);
});

/** The single owner's staging lane for the default fixture owner. */
function fixtureStaging(root: string): string {
  return path.join(root, 'state', 'profiles', 'owner', '.state', 'media-staging');
}
