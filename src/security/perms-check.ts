import * as fs from 'fs';

export interface PermsCheckResult {
  secure: boolean;
  warnings: string[];
}

export function verifyWorkspacePermissions(workspacePath: string): PermsCheckResult {
  const warnings: string[] = [];
  try {
    const stat = fs.statSync(workspacePath);
    const perms = stat.mode & 0o777;
    if (perms > 0o700) {
      warnings.push(`Workspace ${workspacePath} has perms ${perms.toString(8)} (should be 0700 or stricter)`);
    }
  } catch {
    warnings.push(`Cannot stat workspace ${workspacePath}`);
  }
  return { secure: warnings.length === 0, warnings };
}
