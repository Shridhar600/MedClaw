import * as fs from 'fs';
import * as path from 'path';
import { HeartbeatStore } from '../../src/scheduler/store';
import { HeartbeatScheduler } from '../../src/scheduler/runtime';
import { createCronManageTool } from '../../src/tools/cron-manage';
import { makeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';

/** Run the installed converter, with a finite brake even when the preflight is missing. */
async function withObservedCronExpansion(
  run: (observation: { calls: () => number; inputs: () => readonly string[][]; reset: () => void }) => Promise<void>,
): Promise<void> {
  const source = fs.readFileSync(require.resolve('node-cron/src/convert-expression/range-conversion'), 'utf8');
  expect(Buffer.byteLength(source)).toBeLessThan(16 * 1024);
  expect(source.split('numbers.push(i);')).toHaveLength(2);
  let calls = 0;
  let steps = 0;
  const inputs: string[][] = [];
  const convert = new Function('module', 'step',
    `${source.replace('numbers.push(i);', 'step(); numbers.push(i);')}\nreturn module.exports;`,
  )({ exports: {} }, () => {
    if (++steps >= 2048) throw new Error('FINITE_RANGE_BRAKE');
  }) as (expressions: string[]) => string[];
  jest.doMock('node-cron/src/convert-expression/range-conversion', (): ((expressions: string[]) => string[]) => (expressions: string[]): string[] => {
    calls += 1;
    inputs.push([...expressions]);
    steps = 0;
    return convert(expressions);
  });
  try {
    await jest.isolateModulesAsync(() => run({ calls: () => calls, inputs: () => inputs, reset: (): void => { calls = 0; inputs.length = 0; } }));
  } finally {
    jest.dontMock('node-cron/src/convert-expression/range-conversion');
  }
}

describe('cron_manage tool', () => {
  let tmpDir: string;
  let workspacePath: string;
  let storePath: string;
  let scheduler: HeartbeatScheduler;

  beforeEach(async () => {
    tmpDir = makeTestTemp('redacted-cron-manage-');
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
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
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

  it('refuses cron amplification before conversion or publication, preserving owner reminders across edits and restart', async () => {
    const fixture = writeConfigFixture(path.join(tmpDir, 'bounded-cron'));
    const owner = await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId);
    const ownerBytes = fs.readFileSync(fixture.ownerRecord);
    await withObservedCronExpansion(async (expansion) => {
      const { HeartbeatScheduler: Scheduler, HeartbeatStore: Store } = await import('../../src/scheduler');
      const { createCronManageTool: makeTool } = await import('../../src/tools/cron-manage');
      const cron = jest.requireActual<typeof import('node-cron')>('node-cron');
      const registration = jest.spyOn(cron, 'schedule'); // real timers, no behavior replaced
      const store = new Store(fixture.storePath);
      const triggered: string[] = [];
      const makeScheduler = (): HeartbeatScheduler => new Scheduler(store, async (job) => {
        triggered.push(job.id);
      }, 'UTC', { canAddressChat: (chat) => owner.admission.ownsDestination(chat) });
      let current = makeScheduler();
      try {
        await current.start();
        let tool = makeTool(current, fixture.workspace);
        const create = await tool.execute({ action: 'create', title: 'Owner check-in', prompt: 'Synthetic check-in', cron: '0 8 * * *' }, { chatId: 'owner-chat' });
        expect(create.isError).not.toBe(true);
        expect(expansion.calls()).toBeGreaterThan(0);
        expect(registration).toHaveBeenCalledTimes(1);
        const [job] = await new Store(fixture.storePath).list();
        expect(job).toMatchObject({ chatId: 'owner-chat', enabled: true, cron: '0 8 * * *' });
        for (const supported of ['0 */15 8-10 * January,Sep Monday-Friday', '0 30-0/15 10-8 * Dec-Jan Fri-Mon', '0 8 * * 7-7', '0/1000000000 0 8 * * *']) {
          await current.updateJob(job.id, { cron: supported });
          expect(await new Store(fixture.storePath).get(job.id)).toMatchObject({ id: job.id, cron: supported, enabled: true });
        }
        await current.updateJob(job.id, { cron: '0 8 * * *' });
        const unsafe = ['0 8 1-1000000000 * *', '0 8 1-2-1000000000 * *', '0-1000000000 0 8 * * *', '0 8 * JanJanJanJanJanJanJanJanJanJan-2 *', '0 8 9007199254740992-9007199254740992 * *', `${Array.from({ length: 10 }, () => '0-59').join(',')} 8 * * *`, `${'0'.repeat(1025)} 8 * * *`];
        for (const expression of unsafe) {
          const liveBytes = fs.readFileSync(fixture.storePath);
          const markdown = fs.readFileSync(path.join(fixture.workspace, 'HEARTBEAT.md'));
          const registrations = registration.mock.calls.length;
          const liveTask = registration.mock.results[registrations - 1].value as import('node-cron').ScheduledTask;
          const stop = jest.spyOn(liveTask, 'stop');
          expansion.reset();
          try {
            const refused = await tool.execute({ action: 'create', title: 'Refused', prompt: 'Synthetic', cron: expression }, { chatId: 'owner-chat' });
            expect(expansion.calls()).toBe(0); // fails on the installed converter, not only an error string
            expect(refused.isError).toBe(true);
            expect(refused.content[0].text).not.toContain(expression);
            await expect(current.updateJob(job.id, { cron: expression })).rejects.toThrow('Invalid cron');
            expect(expansion.calls()).toBe(0);
            expect(registration).toHaveBeenCalledTimes(registrations);
            expect(stop).not.toHaveBeenCalled();
            expect(fs.readFileSync(fixture.storePath)).toEqual(liveBytes);
            expect(fs.readFileSync(path.join(fixture.workspace, 'HEARTBEAT.md'))).toEqual(markdown);
            await current.pause(job.id);
            expect(stop).toHaveBeenCalledTimes(1); // same live task, actual pause is the positive control
          } finally { stop.mockRestore(); }
          await store.update(job.id, { cron: expression });
          const pausedBytes = fs.readFileSync(fixture.storePath);
          expansion.reset();
          const resume = await tool.execute({ action: 'resume', id: job.id });
          expect(expansion.calls()).toBe(0);
          expect(resume.isError).toBe(true);
          expect(resume.content[0].text).not.toContain(expression);
          await expect(current.updateJob(job.id, { enabled: true })).rejects.toThrow('Invalid cron');
          expect(expansion.calls()).toBe(0);
          expect(fs.readFileSync(fixture.storePath)).toEqual(pausedBytes);
          expect(registration).toHaveBeenCalledTimes(registrations);
          await current.updateJob(job.id, { cron: '0 8 * * *' }); // paused edits remain administrable
          expect((await tool.execute({ action: 'resume', id: job.id })).isError).not.toBe(true);
          expect(await new Store(fixture.storePath).get(job.id)).toMatchObject({ enabled: true, cron: '0 8 * * *' });
        }

        await current.stop();
        await store.update(job.id, { cron: unsafe[0] });
        const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          current = makeScheduler();
          expansion.reset();
          const registrations = registration.mock.calls.length;
          await current.start();
          expect(expansion.calls()).toBe(0);
          expect(registration).toHaveBeenCalledTimes(registrations);
          expect(await new Store(fixture.storePath).get(job.id)).toMatchObject({ enabled: false, lastOutcome: 'error' });
          await current.runNow(job.id);
          expect(triggered).toEqual([]);
        } finally { errors.mockRestore(); }
        await current.updateJob(job.id, { cron: '0 8 * * *' });
        tool = makeTool(current, fixture.workspace);
        expect((await tool.execute({ action: 'resume', id: job.id })).isError).not.toBe(true);
        await current.stop();
        current = makeScheduler();
        const registrations = registration.mock.calls.length;
        await current.start();
        expect(registration).toHaveBeenCalledTimes(registrations + 1);
        await current.runNow(job.id);
        expect(triggered).toEqual([job.id]);
        expect((await new Store(fixture.storePath).get(job.id))?.lastRunAt).toBeDefined();
        expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBytes);
      } finally {
        await current.stop();
        registration.mockRestore();
      }
    });
  });

  it('does not re-enter expanding recovery when disabling a malformed persisted cron fails', async () => {
    await withObservedCronExpansion(async (expansion) => {
      const { HeartbeatScheduler: Scheduler, HeartbeatStore: Store } = await import('../../src/scheduler');
      const store = new Store(storePath);
      const bad = await store.create({ title: 'Malformed', chatId: 'owner-chat', cron: '0 8 1-1000000000 * *', timezone: 'UTC', prompt: 'Synthetic', source: 'user', kind: 'routine' });
      const good = await store.create({ title: 'Valid recovery', chatId: 'owner-chat', cron: '0 8 * * *', timezone: 'UTC', prompt: 'Synthetic', source: 'user', kind: 'routine' });
      const persisted = await store.list();
      fs.writeFileSync(storePath, JSON.stringify(persisted.map(job => ({ ...job, createdAt: '2026-01-01T00:00:00.000Z' }))));
      const update = store.update.bind(store);
      jest.spyOn(store, 'update').mockImplementation((id, patch) => id === bad.id ? Promise.reject(new Error('Synthetic write unavailable')) : update(id, patch));
      const triggered: string[] = [];
      const current = new Scheduler(store, async (job) => { triggered.push(job.id); }, 'UTC', {
        recoveryEnabled: true, now: (): Date => new Date('2026-01-02T08:01:00.000Z'), canAddressChat: (chat): boolean => chat === 'owner-chat',
      });
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(current.start()).resolves.toBeUndefined();
        expect(expansion.inputs().filter(fields => fields.includes('1-1000000000'))).toEqual([]);
        expect(expansion.calls()).toBeGreaterThan(0); // valid registration/recovery must use the real converter
        expect(triggered).toEqual([good.id]);
        expect(await new Store(storePath).get(good.id)).toMatchObject({ enabled: true, lastRunAt: '2026-01-02T08:01:00.000Z' });
        expect(await new Store(storePath).get(bad.id)).toMatchObject({ enabled: true, cron: '0 8 1-1000000000 * *' });
      } finally {
        await current.stop();
        errors.mockRestore();
      }
    });
  });
});
