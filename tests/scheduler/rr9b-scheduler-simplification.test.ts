import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HeartbeatStore } from '../../src/scheduler/store';

const fsReal = jest.requireActual<typeof import('fs')>('fs');

describe('RR-9b scheduler state simplification', () => {
  it('uses one simple cold JSON read and the fingerprint cache for warm reads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9b-scheduler-'));
    const filePath = path.join(dir, 'jobs.json');
    fs.writeFileSync(filePath, JSON.stringify([{
      id: 'job-1',
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'Asia/Kolkata',
      prompt: 'Ask how the user is feeling.',
      enabled: true,
      source: 'system',
      kind: 'routine',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    }]));
    const store = new HeartbeatStore(filePath);
    const readFile = jest.spyOn(fsReal, 'readFileSync');
    const parse = jest.spyOn(JSON, 'parse');

    try {
      await expect(store.list()).resolves.toHaveLength(1);
      await expect(store.list()).resolves.toHaveLength(1);
      expect(readFile.mock.calls.filter(([file]) => String(file) === filePath)).toHaveLength(1);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      readFile.mockRestore();
      parse.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
