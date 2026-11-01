
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

describe('workspace-local temporary data', () => {
  it('has no source or test file calling os.tmpdir', () => {
    const offenders: string[] = [];
    const files = [
      ...sourceFilesUnder(path.join(REPO_ROOT, 'src')),
      ...sourceFilesUnder(path.join(REPO_ROOT, 'tests')),
    ];
    for (const file of files) {
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
    const offenders: string[] = [];
    const files = [
      ...sourceFilesUnder(path.join(REPO_ROOT, 'src')),
      ...sourceFilesUnder(path.join(REPO_ROOT, 'tests')),
    ];
    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
      const writesToSystemTemp =
        /(?:mkdtempSync|mkdirSync|writeFileSync|appendFileSync|createWriteStream|rmSync|readFileSync|readdirSync|openSync)\s*\([^)]*['"`](?:\/tmp\/|\/var\/folders\/)/.test(code);
      if (writesToSystemTemp) offenders.push(path.relative(REPO_ROOT, file));
    }

    const self = path.join('tests', 'security', 'workspace-temp.test.ts');
    expect(offenders.filter((file) => file !== self)).toEqual([]);
  });

  it('resolves makeTestTemp inside the gitignored workspace root', () => {
    const dir = makeTestTemp('temp-contract');
    try {
      expect(isInsideTestTemp(dir)).toBe(true);
      const mode = fs.statSync(dir).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    } finally {
      removeTestTemp(dir);
    }
  });
});
