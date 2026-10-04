import * as fs from 'fs';
import * as path from 'path';

import { SqliteEventSink } from '../../src/indexstore';
import { runEventSinkContract } from '../ports/event-sink.contract';
import { makeTestTemp } from '../helpers/test-temp';

const tmpDirs: string[] = [];

runEventSinkContract(() => {
  const dir = makeTestTemp('redacted-eventsink-');
  tmpDirs.push(dir);
  return new SqliteEventSink({ dbPath: path.join(dir, 'search.db') });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
