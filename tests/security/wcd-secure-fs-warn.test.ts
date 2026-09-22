// W-C/D hostile-panel fix pass — secure-fs warn sanitization (PPHI / SB-14).
// Proven RED on p1-memory-core @ cbf6c40: the warn carried the ABSOLUTE target
// path AND the raw err.message (e.g. `ENOENT: ... chmod '/abs/identifying/path'`).
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { secureChmodFile } from '../../src/security';

describe('W-C/D fix pass — secure-fs warn never logs abs paths or raw error messages', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a failing chmod warns with basename + sanitized reason only', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcd-securefs-'));
    // Real failure: the target does not exist → chmodSync throws ENOENT whose raw
    // message embeds the absolute identifying path.
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
