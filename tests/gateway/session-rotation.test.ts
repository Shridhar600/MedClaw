import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { SessionManager } from '../../src/gateway/session';

describe('SessionManager JSONL rotation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-session-rotation-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rotates active JSONL to .1.gz before the next append when over threshold', async () => {
    const manager = new SessionManager(
      240, 1440, tmpDir,
      undefined, undefined, undefined, 'default',
      { maxSizeBytes: 100, maxArchived: 3 },
    );

    const jsonlPath = path.join(tmpDir, 'active-chat-rot.jsonl');
    const oversizedContent = 'x'.repeat(200);
    fs.writeFileSync(jsonlPath, oversizedContent + '\n');

    await manager.addTurn(
      'chat-rot',
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    );

    expect(fs.existsSync(jsonlPath)).toBe(true);
    const activeContent = fs.readFileSync(jsonlPath, 'utf-8');
    const activeLines = activeContent.trim().split('\n').filter(l => l.length > 0);
    expect(activeLines.length).toBe(2);
    const parsedUser = JSON.parse(activeLines[0]);
    expect(parsedUser.content).toBe('Hello');

    const archivePath = jsonlPath + '.1.gz';
    expect(fs.existsSync(archivePath)).toBe(true);
    const decompressed = zlib.gunzipSync(fs.readFileSync(archivePath)).toString('utf-8');
    expect(decompressed).toContain(oversizedContent);
  });

  it('append still lands in a fresh active file after rotation', async () => {
    const manager = new SessionManager(
      240, 1440, tmpDir,
      undefined, undefined, undefined, 'default',
      { maxSizeBytes: 100, maxArchived: 3 },
    );

    const jsonlPath = path.join(tmpDir, 'active-chat-fresh.jsonl');
    fs.writeFileSync(jsonlPath, 'x'.repeat(200) + '\n');

    await manager.recordTurn('chat-fresh', [
      { role: 'user', content: 'post-rotation-user' },
      { role: 'assistant', content: 'post-rotation-assistant' },
    ]);

    expect(fs.existsSync(jsonlPath + '.1.gz')).toBe(true);

    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.content).toBe('post-rotation-user');
    const second = JSON.parse(lines[1]);
    expect(second.content).toBe('post-rotation-assistant');
  });

  it('prepareHistory on a freshly-rotated session does not crash', async () => {
    const manager = new SessionManager(
      240, 1440, tmpDir,
      undefined, undefined, undefined, 'default',
      { maxSizeBytes: 100, maxArchived: 3 },
    );

    const jsonlPath = path.join(tmpDir, 'active-chat-prep.jsonl');
    fs.writeFileSync(jsonlPath, 'x'.repeat(200) + '\n');

    await manager.recordTurn('chat-prep', [
      { role: 'user', content: 'trigger rotation' },
      { role: 'assistant', content: 'ok' },
    ]);

    expect(fs.existsSync(jsonlPath + '.1.gz')).toBe(true);

    const history = await manager.prepareHistory('chat-prep');

    expect(Array.isArray(history)).toBe(true);
  });

  it('does not rotate a file under the injected threshold', async () => {
    const manager = new SessionManager(
      240, 1440, tmpDir,
      undefined, undefined, undefined, 'default',
      { maxSizeBytes: 10_000, maxArchived: 3 },
    );
    const jsonlPath = path.join(tmpDir, 'active-chat-small.jsonl');

    await manager.addTurn(
      'chat-small',
      { role: 'user', content: 'small' },
      { role: 'assistant', content: 'resp' },
    );

    expect(fs.existsSync(jsonlPath + '.1.gz')).toBe(false);
    expect(fs.existsSync(jsonlPath)).toBe(true);
    expect(fs.readFileSync(jsonlPath, 'utf-8')).toContain('small');
  });

  it('uses default 50MB threshold when no rotationConfig is provided', async () => {
    const manager = new SessionManager(240, 1440, tmpDir);
    const jsonlPath = path.join(tmpDir, 'active-chat-default.jsonl');
    fs.writeFileSync(jsonlPath, 'x'.repeat(10_000) + '\n');

    await manager.addTurn(
      'chat-default',
      { role: 'user', content: 'cat' },
      { role: 'assistant', content: 'dog' },
    );

    expect(fs.existsSync(jsonlPath + '.1.gz')).toBe(false);
    expect(fs.readFileSync(jsonlPath, 'utf-8')).toContain('cat');
  });
});