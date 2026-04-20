import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

describe('daemon startup config guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-daemon-startup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits non-zero with init guidance when explicit config is missing', () => {
    const missingConfig = path.join(tmpDir, 'config.json');

    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, REDACTED_CONFIG_PATH: missingConfig },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('npm run cli -- init');
  });
});
