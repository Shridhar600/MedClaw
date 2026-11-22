
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** Absolute path of the workspace-local synthetic root. */
export const TEST_TEMP_ROOT = path.resolve(process.cwd(), '.test-tmp');

export function isInsideTestTemp(candidate: string): boolean {
  const relative = path.relative(TEST_TEMP_ROOT, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function makeTestTemp(label: string): string {
  const slug = label.replace(/[^a-zA-Z0-9._-]/g, '-');
  const dir = path.join(TEST_TEMP_ROOT, `${slug}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Remove a directory created by `makeTestTemp`. Safe to call more than once. */
export function removeTestTemp(dir: string | undefined): void {
  if (!dir) return;
  const relative = path.relative(TEST_TEMP_ROOT, dir);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to remove a directory outside the test temp root: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
