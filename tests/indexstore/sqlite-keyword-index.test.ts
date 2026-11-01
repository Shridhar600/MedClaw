import * as fs from 'fs';
import * as path from 'path';

import { SqliteKeywordIndex } from '../../src/indexstore';
import { runKeywordIndexContract } from '../ports/keyword-index.contract';
import { makeTestTemp } from '../helpers/test-temp';

const tmpDirs: string[] = [];

runKeywordIndexContract(() => {
  const dir = makeTestTemp('redacted-kwidx-');
  tmpDirs.push(dir);
  return new SqliteKeywordIndex({ dbPath: path.join(dir, 'search.db') });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
