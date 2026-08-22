import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SqliteEventSink } from '../../src/indexstore';
import { runEventSinkContract } from '../ports/event-sink.contract';

const tmpDirs: string[] = [];

runEventSinkContract(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-eventsink-'));
  tmpDirs.push(dir);
  return new SqliteEventSink({ dbPath: path.join(dir, 'search.db') });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
