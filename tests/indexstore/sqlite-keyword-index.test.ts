import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SqliteKeywordIndex } from '../../src/indexstore';
import { runKeywordIndexContract } from '../ports/keyword-index.contract';

const tmpDirs: string[] = [];

// Each index gets its own isolated temp search.db (its own better-sqlite3 connection over
// the P0-owned chunks/chunks_fts tables — D6). NEVER touches ~/.redacted.
runKeywordIndexContract(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-kwidx-'));
  tmpDirs.push(dir);
  return new SqliteKeywordIndex({ dbPath: path.join(dir, 'search.db') });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
