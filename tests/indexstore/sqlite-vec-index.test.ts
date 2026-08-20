import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SqliteVecIndex } from '../../src/indexstore';
import { runVectorIndexContract } from '../ports/vector-index.contract';

const tmpDirs: string[] = [];

// Each adapter instance gets its own isolated temp search.db (a second better-sqlite3
// connection over sqlite-vec — the P2-liftable seam). NEVER touches ~/.redacted.
runVectorIndexContract((dimension) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-vecidx-'));
  tmpDirs.push(dir);
  return new SqliteVecIndex({ dbPath: path.join(dir, 'search.db'), dimension });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
