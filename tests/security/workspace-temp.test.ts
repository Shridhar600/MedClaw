// tests/security/workspace-temp.test.ts
//
// Enforces R-14: no work — including test work — creates or touches files in `/tmp`, `$HOME`, or another
// workspace.
//
// WHY A TEST AND NOT A REDIRECT
//
// I tried to enforce this centrally instead of migrating call sites: patch `os.tmpdir` so every caller
// resolves into the gitignored `.test-tmp/`. It fails twice over on current Node, and both failures are
// worth recording because the idea looked correct.
//
//   1. Setting `TMPDIR`/`TMP`/`TEMP` does not work. `process.env` ends up correct and `os.tmpdir()` still
//      returns the macOS per-user directory. A standalone `TMPDIR=... node -e 'os.tmpdir()'` DOES honour
//      it, so the env route looks proven right up until it runs under a jest worker.
//   2. Patching the function does not work either. `os.tmpdir` is a non-configurable accessor on Node 26:
//      assignment throws "only a getter", and `Object.defineProperty` throws "Cannot redefine property".
//
// A safety net that does not actually catch anything is worse than no net, because it reads like
// compliance. So the call sites are migrated to `makeTestTemp`, and THIS test is what keeps them
// migrated: it fails the moment a suite reintroduces `os.tmpdir()`.

import * as fs from 'fs';
import * as path from 'path';

import { isInsideTestTemp, makeTestTemp, removeTestTemp } from '../helpers/test-temp';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Every `.ts` file under a directory, skipping build output and dotted directories. */
function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

describe('workspace-local temporary data (R-14)', () => {
  it('has no source or test file calling os.tmpdir()', () => {
    const offenders: string[] = [];
    const files = [
      ...sourceFilesUnder(path.join(REPO_ROOT, 'src')),
      ...sourceFilesUnder(path.join(REPO_ROOT, 'tests')),
    ];
    for (const file of files) {
      // Strip line comments so a suite that explains WHY it must not use os.tmpdir() is not an
      // offender. A call in real code is still an offender.
      const code = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      if (/os\.tmpdir\(/.test(code) || /\btmpdir\(/.test(code)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }

    // This file necessarily contains the pattern, inside its regexes.
    const self = path.join('tests', 'security', 'workspace-temp.test.ts');
    expect(offenders.filter((file) => file !== self)).toEqual([]);
  });

  it('has no source or test file hardcoding an absolute system-temp path for real IO', () => {
    // Narrower than it looks: a quoted `/tmp/...` CONFIG VALUE (a workspace path the operator would
    // choose) is legitimate and common in CLI fixtures, so those are not flagged. What must not appear is
    // an absolute system-temp path reaching a filesystem call, which is what this looks for.
    const offenders: string[] = [];
    const files = [
      ...sourceFilesUnder(path.join(REPO_ROOT, 'src')),
      ...sourceFilesUnder(path.join(REPO_ROOT, 'tests')),
    ];
    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      // An absolute /tmp or macOS per-user temp path handed to a write/create/read call.
      const writesToSystemTemp =
        /(?:mkdtempSync|mkdirSync|writeFileSync|appendFileSync|createWriteStream|rmSync|readFileSync|readdirSync|openSync)\s*\([^)]*['"`](?:\/tmp\/|\/var\/folders\/)/.test(code);
      if (writesToSystemTemp) offenders.push(path.relative(REPO_ROOT, file));
    }

    const self = path.join('tests', 'security', 'workspace-temp.test.ts');
    expect(offenders.filter((file) => file !== self)).toEqual([]);
  });

  it('resolves makeTestTemp inside the gitignored workspace root', () => {
    // The positive half: prove the helper the suites now use actually lands in the workspace and is
    // owner-only, so the migration did not just move the problem.
    const dir = makeTestTemp('r14-contract');
    try {
      expect(isInsideTestTemp(dir)).toBe(true);
      const mode = fs.statSync(dir).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    } finally {
      removeTestTemp(dir);
    }
  });
});
