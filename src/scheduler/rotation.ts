import * as fs from 'fs';
import * as zlib from 'zlib';

export interface RotationConfig {
  maxSizeBytes: number;
  maxArchived: number;
}

const DEFAULTS: RotationConfig = {
  maxSizeBytes: 50 * 1024 * 1024,
  maxArchived: 3,
};

export function rotateFileIfNeeded(filePath: string, config?: Partial<RotationConfig>): boolean {
  const resolved: RotationConfig = { ...DEFAULTS, ...config };

  if (!fs.existsSync(filePath)) {
    return false;
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= resolved.maxSizeBytes) {
    return false;
  }

  // Prune oldest archive beyond maxArchived
  const oldestPath = filePath + '.' + resolved.maxArchived + '.gz';
  if (fs.existsSync(oldestPath)) {
    fs.unlinkSync(oldestPath);
  }

  // Shift existing archives: N → N+1 (from oldest to newest)
  for (let i = resolved.maxArchived - 1; i >= 1; i--) {
    const src = filePath + '.' + i + '.gz';
    const dst = filePath + '.' + (i + 1) + '.gz';
    if (fs.existsSync(src)) {
      fs.renameSync(src, dst);
    }
  }

  const stagingPath = filePath + '.rotating';
  fs.renameSync(filePath, stagingPath);

  try {
    const content = fs.readFileSync(stagingPath);
    const compressed = zlib.gzipSync(content);
    fs.writeFileSync(filePath + '.1.gz', compressed, { mode: 0o600 });
    fs.unlinkSync(stagingPath);
    return true;
  } catch (error) {
    // Restore the staged file; if even that fails it stays as `<file>.rotating` for manual recovery.
    try {
      fs.renameSync(stagingPath, filePath);
    } catch { /* leaves stagingPath in place */ }
    return false;
  }
}
