import * as path from 'path';
import { secureChmodFile } from '../../src/security';
import { makeTestTemp } from '../helpers/test-temp';

describe('secure-fs warn never logs abs paths or raw error messages', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a failing chmod warns with basename + sanitized reason only', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tmpDir = makeTestTemp('securefs-');
    const target = path.join(tmpDir, 'deeply', 'identifying', 'profile-x', 'medications.md');

    secureChmodFile(target);

    const out = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toMatch(/medications\.md/); // basename IS logged (type-level info)
    expect(out).not.toContain(tmpDir); // never the absolute path
    expect(out).not.toContain('profile-x');
    expect(out).not.toContain('no such file'); // never the raw message
    expect(out).toMatch(/ENOENT|Error/); // sanitized error identity survives (cross-realm safe)
  });
});
