import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeartbeatStore } from '../../src/scheduler/store';
import { HeartbeatScheduler } from '../../src/scheduler/runtime';
import { createCronManageTool } from '../../src/tools/cron-manage';

describe('cron_manage tool', () => {
  let tmpDir: string;
  let workspacePath: string;
  let storePath: string;
  let scheduler: HeartbeatScheduler;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-cron-manage-'));
    workspacePath = path.join(tmpDir, 'workspace');
    storePath = path.join(tmpDir, 'heartbeats', 'jobs.json');
    fs.mkdirSync(workspacePath, { recursive: true });
    const store = new HeartbeatStore(storePath);
    scheduler = new HeartbeatScheduler(store, async () => undefined, 'Asia/Kolkata');
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a heartbeat job and returns the created id', async () => {
    const tool = createCronManageTool(scheduler, workspacePath);

    const result = await tool.execute({
      action: 'create',
      title: 'Evening check-in',
      chatId: 'chat-1',
      cron: '0 21 * * *',
      prompt: 'Ask for a short end-of-day health summary.',
    });

    expect(result.content[0].text).toContain('Evening check-in');
    const jobs = await scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Evening check-in');
    expect(fs.readFileSync(path.join(workspacePath, 'HEARTBEAT.md'), 'utf8')).toContain('Evening check-in');
  });

  it('lists jobs in a human-readable format', async () => {
    const tool = createCronManageTool(scheduler, workspacePath);
    await scheduler.createJob({
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'How are you feeling today?',
      source: 'system',
    });

    const result = await tool.execute({ action: 'list' });
    expect(result.content[0].text).toContain('Morning check-in');
    expect(result.content[0].text).toContain('enabled');
  });

  it('synchronizes HEARTBEAT.md on pause and delete', async () => {
    const tool = createCronManageTool(scheduler, workspacePath);

    const createResult = await tool.execute({
      action: 'create',
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'How are you feeling today?',
    });
    const createdId = createResult.content[0].text.match(/id:\s*([a-f0-9-]+)/i)?.[1];
    expect(createdId).toBeDefined();

    await tool.execute({ action: 'pause', id: createdId });
    const pausedContent = fs.readFileSync(path.join(workspacePath, 'HEARTBEAT.md'), 'utf8');
    expect(pausedContent).toContain('paused');

    await tool.execute({ action: 'delete', id: createdId });
    const deletedContent = fs.readFileSync(path.join(workspacePath, 'HEARTBEAT.md'), 'utf8');
    expect(deletedContent).not.toContain('Morning check-in');
  });

  it('defaults create chatId from run context when omitted', async () => {
    const tool = createCronManageTool(scheduler, workspacePath);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool.execute as any)(
      {
        action: 'create',
        title: 'Context check-in',
        cron: '0 10 * * *',
        prompt: 'Use current chat id.',
      },
      { chatId: 'chat-context-1' },
    );

    expect(result.isError).not.toBe(true);
    const jobs = await scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].chatId).toBe('chat-context-1');
  });
});
