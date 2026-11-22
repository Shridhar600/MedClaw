import fs = require('fs');
import * as path from 'path';
import { readConfigDocument, writeConfigDocument } from '../../src/runtime';
import { setConfigValue } from '../../src/cli/admin';
import { writeConfigFixture } from '../helpers/config-fixture';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';
import { makeTestTemp } from '../helpers/test-temp';

describe('config publication', () => {
  let root: string;
  beforeEach(() => { root = makeTestTemp('config-publication-'); });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('keeps the old bytes when a write fails, never touches a file it does not own, and publishes 0600', async () => {
    const fixture = writeConfigFixture(root);
    await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId);
    const configBefore = fs.readFileSync(fixture.configPath);
    const now = 1_791_460_000_000;
    const tmp = path.join(root, `.config.json.tmp-${process.pid}-${now}`);
    jest.spyOn(Date, 'now').mockReturnValue(now);

    fs.writeFileSync(tmp, 'unowned collision sentinel', { mode: 0o400 });
    await expect(setConfigValue(fixture.configPath, 'agent.maxIterations', '7')).rejects.toThrow(/configuration is unchanged/);
    expect(fs.readFileSync(fixture.configPath)).toEqual(configBefore);
    expect(fs.readFileSync(tmp, 'utf8')).toBe('unowned collision sentinel');
    fs.rmSync(tmp, { force: true });

    const stored = readConfigDocument(fixture.configPath, root).stored;
    stored.agent.maxIterations = 7;
    expect(writeConfigDocument(fixture.configPath, stored, { sync: {
      syncFile: () => { throw new Error('synthetic flush fault'); }, syncDir: () => undefined,
    } })).toEqual({ status: 'failed', originalBytesPreserved: true, reason: 'flush-failed' });
    expect(fs.readFileSync(fixture.configPath)).toEqual(configBefore);
    expect(fs.existsSync(tmp)).toBe(false);

    expect(await setConfigValue(fixture.configPath, 'agent.maxIterations', '8')).toContain('Restart the daemon');
    expect(readConfigDocument(fixture.configPath, root).stored.agent.maxIterations).toBe(8);
    expect(fs.statSync(fixture.configPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(tmp)).toBe(false);
  });
});
