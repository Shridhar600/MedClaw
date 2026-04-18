import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CreateHeartbeatJobInput } from '../../src/scheduler/types';
import { HeartbeatStore } from '../../src/scheduler/store';
import { reconcilePolicyJobs } from '../../src/scheduler/reconciler';
import { HeartbeatScheduler } from '../../src/scheduler/runtime';

function makeDesiredJob(
  patch: Partial<CreateHeartbeatJobInput & { prompt: string; policyKey: string }> = {},
): CreateHeartbeatJobInput {
  return {
    title: patch.title ?? 'Morning check-in',
    chatId: patch.chatId ?? 'chat-1',
    cron: patch.cron ?? '0 8 * * *',
    timezone: patch.timezone ?? 'Asia/Kolkata',
    prompt: patch.prompt ?? 'Morning prompt v1',
    source: patch.source ?? 'system',
    kind: patch.kind ?? 'routine',
    policyKey: patch.policyKey ?? 'defaults:morning-check-in',
  };
}

describe('reconcilePolicyJobs', () => {
  let tmpDir: string;
  let storePath: string;
  let scheduler: HeartbeatScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-reconciler-'));
    storePath = path.join(tmpDir, 'heartbeats', 'jobs.json');
    scheduler = new HeartbeatScheduler(new HeartbeatStore(storePath), async () => undefined, 'Asia/Kolkata');
  });

  afterEach(async () => {
    await scheduler.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates missing system jobs and updates changed ones by policyKey', async () => {
    const first = await reconcilePolicyJobs(scheduler, [
      makeDesiredJob({ policyKey: 'defaults:morning-check-in', prompt: 'Morning prompt v1' }),
    ]);
    expect(first.created).toBe(1);

    const second = await reconcilePolicyJobs(scheduler, [
      makeDesiredJob({ policyKey: 'defaults:morning-check-in', prompt: 'Morning prompt v2' }),
    ]);
    expect(second.updated).toBe(1);
    expect((await scheduler.listJobs())[0].prompt).toBe('Morning prompt v2');
  });

  it('removes stale system jobs whose policy source disappeared', async () => {
    await scheduler.createJob(makeDesiredJob({ policyKey: 'goals:goals/bulk.md' }));
    const result = await reconcilePolicyJobs(scheduler, []);
    expect(result.deleted).toBe(1);
  });

  it('does not modify non-system jobs during reconciliation', async () => {
    await scheduler.createJob({
      title: 'User custom reminder',
      chatId: 'chat-1',
      cron: '0 12 * * *',
      prompt: 'Custom',
      source: 'user',
      kind: 'goal',
      policyKey: 'user:custom',
    });

    await reconcilePolicyJobs(scheduler, []);
    const jobs = await scheduler.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe('user');
  });

  it('skips invalid policy jobs instead of persisting them', async () => {
    await reconcilePolicyJobs(scheduler, [
      makeDesiredJob({ policyKey: 'defaults:bad', cron: 'not-a-cron' }),
    ]);

    expect(await scheduler.listJobs()).toHaveLength(0);
  });
});
