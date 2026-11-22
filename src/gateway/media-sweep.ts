import * as fs from 'fs';
import * as path from 'path';
import { inspectContainedDirectory, PathContainmentError } from '../security';
import { isMediaStagingArtifact } from '../runtime';

/** Counts all visited entries, including preserved files, directories and links. */
export const MEDIA_SWEEP_ENTRY_LIMIT = 256;
export type MediaSweepResult =
  | { kind: 'complete'; inspected: number; removed: number }
  | { kind: 'partial'; inspected: number; removed: number; reason: 'entry-limit' | 'io-failed' }
  | { kind: 'unavailable'; inspected: 0; removed: 0; reason: 'invalid-root' | 'io-failed' };

/** Boot-only, nonrecursive cleanup of recognizable regular artifacts beneath owner authority. */
export function sweepStagedMedia(stagingDir: string, trustedBaseDir?: string): MediaSweepResult {
  let root: string;
  try {
    const checked = inspectContainedDirectory(trustedBaseDir, stagingDir);
    if (!checked.exists) return { kind: 'complete', inspected: 0, removed: 0 };
    root = checked.absolutePath;
  } catch (error) {
    return { kind: 'unavailable', inspected: 0, removed: 0,
      reason: error instanceof PathContainmentError ? 'invalid-root' : 'io-failed' };
  }
  let directory: fs.Dir;
  try { directory = fs.opendirSync(root, { bufferSize: 1 }); }
  catch { return { kind: 'unavailable', inspected: 0, removed: 0, reason: 'io-failed' }; }
  let inspected = 0;
  let removed = 0;
  let result: MediaSweepResult;
  try {
    let eof = false;
    while (inspected < MEDIA_SWEEP_ENTRY_LIMIT) {
      const entry = directory.readSync();
      if (entry === null) { eof = true; break; }
      inspected += 1;
      if (!isMediaStagingArtifact(entry.name)) continue;
      const candidate = path.join(root, entry.name);
      try {
        // lstat never follows links, including recognizable-looking ones.
        if (!fs.lstatSync(candidate).isFile()) continue;
        fs.unlinkSync(candidate);
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    result = eof ? { kind: 'complete', inspected, removed }
      : { kind: 'partial', inspected, removed, reason: 'entry-limit' };
  } catch {
    result = { kind: 'partial', inspected, removed, reason: 'io-failed' };
  } finally {
    try { directory.closeSync(); }
    catch { result = { kind: 'partial', inspected, removed, reason: 'io-failed' }; }
  }
  return result!;
}
