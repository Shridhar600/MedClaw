import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SqliteFactMirror } from '../../src/indexstore';
import { runFactMirrorContract } from '../ports/fact-mirror.contract';

const tmpDirs: string[] = [];

// Each mirror gets its own isolated temp search.db (its own better-sqlite3 connection —
// the mirror layer co-owns search.db with the vec/keyword adapters, D6). NEVER ~/.redacted.
runFactMirrorContract(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-factmirror-'));
  tmpDirs.push(dir);
  return new SqliteFactMirror({ dbPath: path.join(dir, 'search.db') });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
