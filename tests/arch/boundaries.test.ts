import { execSync } from 'child_process';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

describe('architecture boundaries', () => {
  it('npm run arch:check passes with no violations', () => {
    const result = execSync('npm run arch:check 2>&1', {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    // If depcruise finds violations it exits with code != 0 and throws,
    // so if we get here the check passed. Still verify output signals success.
    expect(result).toMatch(/✔|0 violations|no forbidden/i);
  });
});
