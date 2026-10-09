import fs = require('fs');
import * as path from 'path';
import { readConfigDocument, writeConfigDocument } from '../../src/runtime';
import { setConfigValue } from '../../src/cli/admin';
import { writeConfigFixture } from '../helpers/config-fixture';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';
import { makeTestTemp } from '../helpers/test-temp';

describe('config publication owns only its own temporary file', () => {
  let root: string;
  beforeEach(() => { root = makeTestTemp('c05-config-publication-'); });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('preserves an exact collision through config set, cleans owned failures and supports retry/reload', async () => {
    const fixture = writeConfigFixture(root);
    await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId);
    const configBefore = fs.readFileSync(fixture.configPath);
    const ownerBefore = fs.readFileSync(fixture.ownerRecord);
    const now = 1_791_460_000_000;
    const tmp = path.join(root, `.config.json.tmp-${process.pid}-${now}`);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    fs.writeFileSync(tmp, 'unowned collision sentinel', { mode: 0o400 });
    const collision = fs.lstatSync(tmp);
    await expect(setConfigValue(fixture.configPath, 'agent.maxIterations', '7')).rejects.toThrow(/configuration is unchanged/);
    expect(fs.readFileSync(fixture.configPath)).toEqual(configBefore);
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBefore);
    expect(fs.existsSync(tmp)).toBe(true);
    expect(fs.readFileSync(tmp, 'utf8')).toBe('unowned collision sentinel');
    expect(fs.lstatSync(tmp).mode).toBe(collision.mode);
    expect(fs.lstatSync(tmp).ino).toBe(collision.ino);

    // Move only this test's collision fixture aside to exercise an owned temp at the same exact name.
    const savedSentinel = path.join(root, 'saved-collision');
    fs.renameSync(tmp, savedSentinel);
    const stored = readConfigDocument(fixture.configPath, root).stored;
    stored.agent.maxIterations = 7;
    let flushFd: number | undefined;
    expect(writeConfigDocument(fixture.configPath, stored, { sync: {
      syncFile: (fd) => { flushFd = fd; throw new Error('synthetic flush fault'); }, syncDir: () => undefined,
    } })).toEqual({ status: 'failed', originalBytesPreserved: true, reason: 'flush-failed' });
    expect(flushFd).toBeDefined();
    expect(() => fs.fstatSync(flushFd!)).toThrow();
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(fixture.configPath)).toEqual(configBefore);

    const realWrite = fs.writeFileSync;
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (typeof file === 'number') throw new Error('synthetic temp write fault');
      return realWrite(file, ...args);
    });
    try {
      expect(writeConfigDocument(fixture.configPath, stored)).toEqual({ status: 'failed', originalBytesPreserved: true, reason: 'write-failed' });
    } finally { writeSpy.mockRestore(); }
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(fixture.configPath)).toEqual(configBefore);

    const realRename = fs.renameSync;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === tmp && to === fixture.configPath) throw new Error('synthetic rename fault');
      realRename(from, to);
    });
    try {
      expect(writeConfigDocument(fixture.configPath, stored)).toEqual({ status: 'failed', originalBytesPreserved: true, reason: 'write-failed' });
    } finally { renameSpy.mockRestore(); }
    // This temp is owned even though its descriptor already closed before the failed rename.
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(fixture.configPath)).toEqual(configBefore);
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBefore);

    expect(await setConfigValue(fixture.configPath, 'agent.maxIterations', '8')).toContain('Restart the daemon');
    expect(readConfigDocument(fixture.configPath, root).stored.agent.maxIterations).toBe(8);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.statSync(fixture.configPath).mode & 0o777).toBe(0o600);
    stored.agent.maxIterations = 9;
    expect(writeConfigDocument(fixture.configPath, stored, { sync: {
      syncFile: (fd) => fs.fsyncSync(fd), syncDir: () => { throw new Error('synthetic post-rename fault'); },
    } })).toEqual({ status: 'uncertain', originalBytesPreserved: false, reason: 'flush-failed' });
    expect(readConfigDocument(fixture.configPath, root).stored.agent.maxIterations).toBe(9);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(savedSentinel, 'utf8')).toBe('unowned collision sentinel');
    expect(fs.lstatSync(savedSentinel).mode).toBe(collision.mode);
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBefore);
  });

  // Distinct invariant: rename succeeds with an open descriptor, so persisted bytes cannot detect leaks.
  it('closes each real publication descriptor on success and pre-rename failure', () => {
    const fixture = writeConfigFixture(root);
    const stored = readConfigDocument(fixture.configPath, root).stored;
    const realOpen = fs.openSync;
    const realClose = fs.closeSync;
    const active = new Set<number>();
    let created = 0;
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = realOpen(...args);
      if (args[1] === 'wx' && String(args[0]).startsWith(path.join(root, '.config.json.tmp-'))) {
        active.add(fd); created += 1;
      }
      return fd;
    });
    const closeSpy = jest.spyOn(fs, 'closeSync').mockImplementation((fd) => { realClose(fd); active.delete(fd); });
    try {
      for (let index = 0; index < 40; index += 1) {
        stored.agent.maxIterations = index + 1;
        const sync = index % 2 === 0 ? undefined : {
          syncFile: (): never => { throw new Error('synthetic file flush fault'); }, syncDir: (): void => undefined,
        };
        expect(writeConfigDocument(fixture.configPath, stored, { sync }).status).toBe(sync ? 'failed' : 'committed');
        expect(active.size).toBe(0);
      }
      expect(created).toBe(40);
      expect(fs.readdirSync(root).filter((entry) => entry.startsWith('.config.json.tmp-'))).toEqual([]);
    } finally {
      openSpy.mockRestore(); closeSpy.mockRestore();
      for (const fd of active) realClose(fd);
    }
  });
});
