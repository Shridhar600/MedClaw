// tests/helpers/test-temp.ts
//
// Synthetic test data lives INSIDE the workspace, under the gitignored `.test-tmp/` root.
//
// The founder rule for this task is that no work — including test work — may create or touch
// files in `/tmp`, `$HOME`, or another workspace.
//
// R-14 is now CLOSED rather than a residual: every suite that used `os.tmpdir()` was migrated to
// these helpers. `tests/security/workspace-temp.test.ts` fails the moment a suite reintroduces
// `os.tmpdir()`, so the rule is enforced rather than merely stated.
//
// That test is what the migration needed, and it is also what proved the migration could not be
// faked with a central redirect: patching `os.tmpdir` is impossible on current Node (non-
// configurable accessor), and setting `TMPDIR` is ignored by macOS inside a jest worker.
//
// Cleanup is the caller's job (normally `afterEach`). Nothing here reads a real home directory,
// touches the network, or creates owner-scoped content outside the returned directory.

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** Absolute path of the workspace-local synthetic root. */
export const TEST_TEMP_ROOT = path.resolve(process.cwd(), '.test-tmp');

/**
 * Whether `candidate` resolves inside the workspace-local synthetic root.
 *
 * Used by the R-14 workspace-temp contract test to assert that a path a suite actually wrote to is
 * inside the workspace, rather than only asserting that some configuration variable was set.
 */
export function isInsideTestTemp(candidate: string): boolean {
  const relative = path.relative(TEST_TEMP_ROOT, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Create a unique directory for one suite or case. Returns the absolute path; nothing else on
 * disk is touched, and the caller removes it when finished.
 */
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