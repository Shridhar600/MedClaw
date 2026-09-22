import * as fs from 'fs';
import * as path from 'path';

export type PathContainmentReason = 'invalid-component' | 'symlink' | 'outside-base' | 'unavailable';

/** A caller supplied path cannot be resolved safely inside its trusted storage lane. */
export class PathContainmentError extends Error {
  readonly code = 'ERR_PATH_CONTAINMENT';

  constructor(readonly reason: PathContainmentReason) {
    super('Path is not safely contained within the trusted storage lane');
    this.name = 'PathContainmentError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const CONTROL_CHARACTER = /\p{Cc}/u;

function validateComponent(component: unknown): asserts component is string {
  if (
    typeof component !== 'string'
    || component.length === 0
    || component.includes('/')
    || component.includes('\\')
    || component.includes('..')
    || path.posix.isAbsolute(component)
    || path.win32.isAbsolute(component)
    || /^[A-Za-z]:/.test(component)
    || CONTROL_CHARACTER.test(component)
  ) {
    throw new PathContainmentError('invalid-component');
  }
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isDescendantOrSame(root: string, candidate: string): boolean {
  return candidate === root || isStrictDescendant(root, candidate);
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  for (;;) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new PathContainmentError('unavailable');
      }
      const parent = path.dirname(current);
      if (parent === current) throw new PathContainmentError('unavailable');
      current = parent;
    }
  }
}

/**
 * Resolve one or more untrusted path components strictly inside an existing trusted base.
 * Existing path segments are lstat-checked so a pre-existing symlink cannot redirect a PHI path.
 * Missing final components are allowed when their nearest existing parent remains contained.
 */
export function resolveContainedPath(baseDir: string, ...components: string[]): string {
  if (components.length === 0) throw new PathContainmentError('invalid-component');
  for (const component of components) validateComponent(component);

  const absoluteBase = path.resolve(baseDir);
  let realBase: string;
  try {
    realBase = fs.realpathSync(absoluteBase);
  } catch {
    throw new PathContainmentError('unavailable');
  }

  const candidate = path.resolve(absoluteBase, ...components);
  if (!isStrictDescendant(absoluteBase, candidate)) {
    throw new PathContainmentError('outside-base');
  }
  let current = absoluteBase;
  for (const component of components) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new PathContainmentError('symlink');
      }
    } catch (error) {
      if (error instanceof PathContainmentError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') break;
      throw new PathContainmentError('unavailable');
    }
  }

  const existing = nearestExistingPath(candidate);
  let realExisting: string;
  try {
    realExisting = fs.realpathSync(existing);
  } catch {
    throw new PathContainmentError('unavailable');
  }
  if (!isDescendantOrSame(realBase, realExisting)) {
    throw new PathContainmentError('outside-base');
  }
  return candidate;
}
