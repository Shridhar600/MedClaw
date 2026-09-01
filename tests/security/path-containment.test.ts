import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PathContainmentError, resolveContainedPath } from '../../src/security';

describe('resolveContainedPath', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-safe-path-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-safe-path-outside-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('allows a missing child that remains inside an existing base', () => {
    expect(resolveContainedPath(root, 'episodes', 'new-episode.md'))
      .toBe(path.join(root, 'episodes', 'new-episode.md'));
  });

  it('rejects traversal, separators, absolute paths, NUL, and control characters', () => {
    for (const component of [
      '../escape',
      'nested/name',
      'nested\\name',
      '/absolute',
      'C:\\absolute',
      '..',
      'bad\u0000name',
      'bad\nname',
      '',
    ]) {
      expect(() => resolveContainedPath(root, 'episodes', component))
        .toThrow(PathContainmentError);
    }
  });

  it('refuses a pre-existing symlinked lane instead of following it', () => {
    fs.symlinkSync(outside, path.join(root, 'episodes'), 'dir');

    expect(() => resolveContainedPath(root, 'episodes', 'secret.md'))
      .toThrow(PathContainmentError);
  });
});
