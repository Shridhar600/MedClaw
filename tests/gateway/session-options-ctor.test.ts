import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from '../../src/gateway/session';
import { makeTestTemp } from '../helpers/test-temp';

describe('SessionManager options-object constructor', () => {
  let dir: string;
  beforeEach(() => { dir = makeTestTemp('sm-opts-'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('constructs from an options object and records a turn to sessionsPath', async () => {
    const m = new SessionManager({ sessionsPath: dir, profileId: 'p1' });
    await m.recordTurn('c1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
    expect(m.getHistory('c1').map((x) => x.content)).toEqual(['hi', 'yo']);
    const today = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(path.join(dir, `${today}.jsonl`))).toBe(true);
  });
});
