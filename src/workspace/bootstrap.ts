import * as fs from 'fs';
import * as path from 'path';

export const REQUIRED_WORKSPACE_DIRS = [
  'conditions',
  'medications',
  'reports',
  'goals',
  'memory',
  'summaries',
  'archive',
] as const;

export function resolveWorkspaceTemplateDir(projectRoot = process.cwd()): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'workspace'),
    path.join(projectRoot, 'workspace'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Workspace template directory not found. Checked: ${candidates.join(', ')}`);
}

export function listWorkspaceTemplateFiles(templateDir = resolveWorkspaceTemplateDir()): string[] {
  return fs.readdirSync(templateDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

export function ensureWorkspaceBootstrap(
  workspacePath: string,
  options: {
    projectRoot?: string;
    preserveExisting?: boolean;
    log?: (message: string) => void;
  } = {},
): void {
  const templateDir = resolveWorkspaceTemplateDir(options.projectRoot);
  const preserveExisting = options.preserveExisting ?? true;

  fs.mkdirSync(workspacePath, { recursive: true });

  for (const fileName of listWorkspaceTemplateFiles(templateDir)) {
    const source = path.join(templateDir, fileName);
    const dest = path.join(workspacePath, fileName);
    if (preserveExisting && fs.existsSync(dest)) {
      continue;
    }
    fs.copyFileSync(source, dest);
    options.log?.(`Bootstrapped ${fileName} to workspace`);
  }

  for (const dirName of REQUIRED_WORKSPACE_DIRS) {
    fs.mkdirSync(path.join(workspacePath, dirName), { recursive: true });
  }
}
