// src/security/secure-fs.ts
//
// Filesystem permission helpers enforcing the threat-model §5.1 compensating
// control: every PHI-bearing directory is created 0o700 and every PHI-bearing
// file 0o600. The daemon must never crash because of a chmod failure, so every
// mode operation degrades to a `console.warn` and continues.

import * as fs from 'fs';
import * as path from 'path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function warn(operation: string, target: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  console.warn(`[security] ${operation} failed for ${target}: ${reason}`);
}

/** Create a directory (and parents) at 0o700. Warn-and-continue on chmod failure. */
export function secureMkdir(dirPath: string, options: { recursive?: boolean } = {}): void {
  const recursive = options.recursive ?? true;
  fs.mkdirSync(dirPath, { recursive, mode: DIR_MODE });
  // mkdirSync's `mode` is umask-affected and is a no-op for a pre-existing
  // directory, so tighten the leaf explicitly to guarantee 0o700.
  tightenDir(dirPath);
}

/** Recursively tighten a directory subtree (dirs → 0o700, files → 0o600). Warn-and-continue. */
export function secureChmodTree(
  rootPath: string,
  opts: { dirMode?: number; fileMode?: number } = {},
): void {
  const dirMode = opts.dirMode ?? DIR_MODE;
  const fileMode = opts.fileMode ?? FILE_MODE;
  try {
    if (!fs.existsSync(rootPath)) return;
    const stack: string[] = [rootPath];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(cur);
      } catch (err) {
        warn('stat', cur, err);
        continue;
      }
      if (stat.isDirectory()) {
        if ((stat.mode & 0o777) !== dirMode) {
          try {
            fs.chmodSync(cur, dirMode);
          } catch (err) {
            warn('chmodDir', cur, err);
          }
        }
        let entries: string[];
        try {
          entries = fs.readdirSync(cur);
        } catch (err) {
          warn('readdir', cur, err);
          continue;
        }
        for (const entry of entries) {
          stack.push(path.join(cur, entry));
        }
      } else if (stat.isFile()) {
        if ((stat.mode & 0o777) !== fileMode) {
          try {
            fs.chmodSync(cur, fileMode);
          } catch (err) {
            warn('chmodFile', cur, err);
          }
        }
      }
    }
  } catch (err) {
    warn('secureChmodTree', rootPath, err);
  }
}

/** Tighten a single existing directory to 0o700 if loose. Warn-and-continue. */
export function tightenDir(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) return;
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return;
    if ((stat.mode & 0o777) !== DIR_MODE) {
      fs.chmodSync(dirPath, DIR_MODE);
    }
  } catch (err) {
    warn('tightenDir', dirPath, err);
  }
}

/** Tighten a single existing file to 0o600 if loose. Warn-and-continue. */
export function tightenFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;
    if ((stat.mode & 0o777) !== FILE_MODE) {
      fs.chmodSync(filePath, FILE_MODE);
    }
  } catch (err) {
    warn('tightenFile', filePath, err);
  }
}

/** Write a file at 0o600. Creates parent dirs at 0o700. Warn-and-continue on chmod failure. */
export function secureWrite(
  filePath: string,
  content: string | NodeJS.ArrayBufferView,
  encoding: BufferEncoding = 'utf8',
): void {
  secureMkdir(path.dirname(filePath));
  // Tighten a pre-existing loose file we are about to overwrite, so an attacker
  // cannot have widened it on disk between creation and this overwrite.
  tightenFile(filePath);
  fs.writeFileSync(filePath, content, encoding);
  try {
    fs.chmodSync(filePath, FILE_MODE);
  } catch (err) {
    warn('chmod', filePath, err);
  }
}

/**
 * Atomic-style write: write a tmp file at 0o600, rename over the target, then
 * chmod the final path 0o600. The post-rename chmod defends against umask
 * widening of the tmp and against a cross-filesystem rename fallback
 * (copy+delete) that can drop the temp mode. Warn-and-continue on chmod failure.
 */
export function secureWriteViaTmp(
  filePath: string,
  content: string | NodeJS.ArrayBufferView,
  encoding: BufferEncoding = 'utf8',
): void {
  secureMkdir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, encoding);
    try {
      fs.chmodSync(tmpPath, FILE_MODE);
    } catch (err) {
      warn('chmod', tmpPath, err);
    }
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, FILE_MODE);
    } catch (err) {
      warn('chmod', filePath, err);
    }
  } catch (err) {
    // Best-effort cleanup of a leftover tmp so it cannot leak PHI at default mode.
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore secondary cleanup failure
    }
    throw err;
  }
}

/**
 * Append to a file, ensuring 0o600. New files are chmod'd once on creation;
 * pre-existing loose files are tightened on first touch. Subsequent appends to
 * an already-0600 file perform only a cheap statSync (no chmod). Warn-and-continue.
 */
export function secureAppend(filePath: string, content: string, encoding: BufferEncoding = 'utf8'): void {
  secureMkdir(path.dirname(filePath));
  const existed = fs.existsSync(filePath);
  if (existed) {
    tightenFile(filePath);
  }
  fs.appendFileSync(filePath, content, encoding);
  if (!existed) {
    try {
      fs.chmodSync(filePath, FILE_MODE);
    } catch (err) {
      warn('chmod', filePath, err);
    }
  }
}

/** Copy a file then chmod the destination 0o600 (copyFileSync does not restrict modes). Warn-and-continue. */
export function secureCopyFile(srcPath: string, destPath: string): void {
  fs.copyFileSync(srcPath, destPath);
  try {
    fs.chmodSync(destPath, FILE_MODE);
  } catch (err) {
    warn('chmod', destPath, err);
  }
}

/** Chmod a file, warn-and-continue. Defaults to 0o600. */
export function secureChmodFile(filePath: string, mode: number = FILE_MODE): void {
  try {
    fs.chmodSync(filePath, mode);
  } catch (err) {
    warn('chmod', filePath, err);
  }
}