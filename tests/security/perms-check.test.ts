import * as fs from 'fs';
import * as path from 'path';
import { verifyWorkspacePermissions } from '../../src/security/perms-check';
import { makeTestTemp } from '../helpers/test-temp';

describe('verifyWorkspacePermissions', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects 0755 perms as insecure', () => {
    tmpDir = makeTestTemp('perms-test-');
    fs.chmodSync(tmpDir, 0o755);

    const result = verifyWorkspacePermissions(tmpDir);
    expect(result.secure).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('perms');
  });

  it('passes on 0700 perms', () => {
    tmpDir = makeTestTemp('perms-test-');
    fs.chmodSync(tmpDir, 0o700);

    const result = verifyWorkspacePermissions(tmpDir);
    expect(result.secure).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('produces warning for non-existent path', () => {
    const badPath = path.join(makeTestTemp('absent-parent'), 'nonexistent-workspace-' + Date.now());
    const result = verifyWorkspacePermissions(badPath);
    expect(result.secure).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Cannot stat');
  });
});
