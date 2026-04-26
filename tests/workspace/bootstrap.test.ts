import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureWorkspaceBootstrap, listWorkspaceTemplateFiles } from '../../src/workspace/bootstrap';

describe('workspace bootstrap', () => {
  let tmpDir: string;
  let workspacePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-workspace-bootstrap-'));
    workspacePath = path.join(tmpDir, 'workspace');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies repo template files and preserves existing user edits', () => {
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'SOUL.md'), 'custom soul', 'utf8');

    ensureWorkspaceBootstrap(workspacePath, { preserveExisting: true });

    expect(fs.readFileSync(path.join(workspacePath, 'SOUL.md'), 'utf8')).toBe('custom soul');
    for (const fileName of listWorkspaceTemplateFiles()) {
      expect(fs.existsSync(path.join(workspacePath, fileName))).toBe(true);
    }
    expect(fs.existsSync(path.join(workspacePath, 'conditions'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'medications'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'reports'))).toBe(true);
  });
});
