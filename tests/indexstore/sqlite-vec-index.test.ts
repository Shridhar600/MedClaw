import * as fs from 'fs';
import * as path from 'path';

import { SqliteVecIndex } from '../../src/indexstore';
import { runVectorIndexContract } from '../ports/vector-index.contract';
import { makeTestTemp } from '../helpers/test-temp';

const tmpDirs: string[] = [];

runVectorIndexContract((dimension) => {
  const dir = makeTestTemp('redacted-vecidx-');
  tmpDirs.push(dir);
  return new SqliteVecIndex({ dbPath: path.join(dir, 'search.db'), dimension });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
