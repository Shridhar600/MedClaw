import { LLMSemaphore, HeartbeatQueueFullError } from '../../src/tools/semaphore';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('LLMSemaphore', () => {
  let sem: LLMSemaphore;

  beforeEach(() => {
    sem = new LLMSemaphore();
  });

  it('serializes two concurrent user jobs', async () => {
    const order: string[] = [];
    const job1Entered = deferred();
    const job1Done = deferred();
    const job2Started = deferred();

    const p1 = sem.run('user', async () => {
      order.push('job1-start');
      job1Entered.resolve();
      await job1Done.promise;
      order.push('job1-end');
    });

    await job1Entered.promise;

    const p2 = sem.run('user', async () => {
      order.push('job2-start');
      job2Started.resolve();
    });

    // job2 should not start yet — job1 is still running
    await expect(Promise.race([job2Started.promise, Promise.resolve('timeout')])).resolves.toBe('timeout');

    job1Done.resolve();
    await p1;
    await p2;

    expect(order).toEqual(['job1-start', 'job1-end', 'job2-start']);
  });

  it('heartbeat waits while user runs', async () => {
    const order: string[] = [];
    const userRunning = deferred();
    const userDone = deferred();

    const pUser = sem.run('user', async () => {
      order.push('user-start');
      userRunning.resolve();
      await userDone.promise;
      order.push('user-end');
    });

    await userRunning.promise;

    const pHb = sem.run('heartbeat', async () => {
      order.push('heartbeat-start');
    });

    // heartbeat should not start yet
    await expect(Promise.race([pHb.then(() => 'hb-done'), Promise.resolve('timeout')])).resolves.toBe('timeout');

    userDone.resolve();
    await pUser;
    await pHb;

    expect(order).toEqual(['user-start', 'user-end', 'heartbeat-start']);
  });

  it('drains background priority only after user AND heartbeat (F8)', async () => {
    const order: string[] = [];
    const blockerRunning = deferred();
    const blockerDone = deferred();

    const pBlock = sem.run('user', async () => {
      order.push('block-start');
      blockerRunning.resolve();
      await blockerDone.promise;
      order.push('block-end');
    });
    await blockerRunning.promise;

    // Enqueue in reverse-priority order while the blocker holds the semaphore.
    const pBg = sem.run('background', async () => { order.push('bg'); });
    const pHb = sem.run('heartbeat', async () => { order.push('hb'); });
    const pUser = sem.run('user', async () => { order.push('user2'); });

    blockerDone.resolve();
    await Promise.all([pBlock, pBg, pHb, pUser]);

    // Priority order wins over enqueue order: user > heartbeat > background.
    expect(order).toEqual(['block-start', 'block-end', 'user2', 'hb', 'bg']);
  });

  it('serializes multiple heartbeat jobs', async () => {
    const order: string[] = [];

    const p1 = sem.run('heartbeat', async () => {
      order.push('hb1');
    });
    const p2 = sem.run('heartbeat', async () => {
      order.push('hb2');
    });

    await p1;
    await p2;

    expect(order).toEqual(['hb1', 'hb2']);
  });

  it('user arriving while heartbeats are queued runs before them', async () => {
    const order: string[] = [];
    const hb1Started = deferred();
    const hb1Done = deferred();

    const pHb1 = sem.run('heartbeat', async () => {
      order.push('hb1-start');
      hb1Started.resolve();
      await hb1Done.promise;
      order.push('hb1-end');
    });

    await hb1Started.promise;

    const pHb2 = sem.run('heartbeat', async () => {
      order.push('hb2-start');
    });

    // Give hb2 time to be queued
    await Promise.resolve();

    const pUser = sem.run('user', async () => {
      order.push('user-start');
    });

    hb1Done.resolve();
    await pHb1;
    await pUser;
    await pHb2;

    // user should run before hb2 even though hb2 was queued first
    expect(order).toEqual(['hb1-start', 'hb1-end', 'user-start', 'hb2-start']);
  });

  it('a rejecting heartbeat does not deadlock and later jobs still run', async () => {
    const order: string[] = [];

    const p1 = sem.run('heartbeat', async () => {
      order.push('hb1-start');
      throw new Error('boom');
    });

    await p1.catch(() => {});

    const p2 = sem.run('heartbeat', async () => {
      order.push('hb2-start');
    });

    await p2;

    expect(order).toEqual(['hb1-start', 'hb2-start']);
  });

  it('a rejecting user job does not deadlock and later jobs still run', async () => {
    const order: string[] = [];

    const p1 = sem.run('user', async () => {
      order.push('user1-start');
      throw new Error('boom');
    });

    await p1.catch(() => {});

    const p2 = sem.run('user', async () => {
      order.push('user2-start');
    });

    await p2;

    expect(order).toEqual(['user1-start', 'user2-start']);
  });

  it('propagates return values', async () => {
    const result = await sem.run('user', async () => 42);
    expect(result).toBe(42);
  });

  it('propagates errors via rejected promise', async () => {
    const err: unknown = await sem.run('heartbeat', async () => {
      throw new Error('test-error');
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('test-error');
  });

  it('maintains FIFO order within the same priority level', async () => {
    const order: string[] = [];

    const p1 = sem.run('user', async () => {
      order.push('u1');
    });
    const p2 = sem.run('user', async () => {
      order.push('u2');
    });

    await p1;
    await p2;
    expect(order).toEqual(['u1', 'u2']);
  });

  it('multiple user jobs arriving while heartbeat runs all go before remaining heartbeats', async () => {
    const order: string[] = [];
    const hb1Running = deferred();
    const hb1Done = deferred();

    const pHb1 = sem.run('heartbeat', async () => {
      order.push('hb1-start');
      hb1Running.resolve();
      await hb1Done.promise;
      order.push('hb1-end');
    });

    await hb1Running.promise;

    const pHb2 = sem.run('heartbeat', async () => {
      order.push('hb2-start');
    });

    await Promise.resolve();

    const pUser1 = sem.run('user', async () => {
      order.push('u1');
    });
    const pUser2 = sem.run('user', async () => {
      order.push('u2');
    });

    hb1Done.resolve();
    await pHb1;
    await pUser1;
    await pUser2;
    await pHb2;

    expect(order).toEqual(['hb1-start', 'hb1-end', 'u1', 'u2', 'hb2-start']);
  });

  it('an 11th queued heartbeat rejects with queue-full error while user jobs are still accepted', async () => {
    // Occupy the running slot so subsequent heartbeats stay queued.
    const blockerRunning = deferred();
    const blockerDone = deferred();
    const pBlocker = sem.run('heartbeat', async () => {
      blockerRunning.resolve();
      await blockerDone.promise;
    });
    await blockerRunning.promise;

    // Queue MAX_QUEUED_HEARTBEATS (10) heartbeats behind the running one.
    const queued: Array<Promise<void>> = [];
    for (let i = 0; i < 10; i++) {
      queued.push(sem.run('heartbeat', async () => {}));
    }

    // The 11th queued heartbeat must be rejected immediately, with the typed
    // sentinel the gateway instanceof-checks (never a message-string contract).
    const overflow = sem.run('heartbeat', async () => {});
    await expect(overflow).rejects.toThrow('heartbeat queue full');
    await expect(overflow).rejects.toBeInstanceOf(HeartbeatQueueFullError);

    // The independent user cap still leaves room for a user job while the
    // heartbeat queue is full.
    const userResult = sem.run('user', async () => 'user-ok');

    blockerDone.resolve();
    await pBlocker;
    await expect(userResult).resolves.toBe('user-ok');
    await Promise.all(queued);
  });

  it('a user job enqueued while 5 heartbeats wait runs before all of them', async () => {
    const order: string[] = [];
    const blockerRunning = deferred();
    const blockerDone = deferred();

    const pBlocker = sem.run('heartbeat', async () => {
      order.push('blocker-start');
      blockerRunning.resolve();
      await blockerDone.promise;
      order.push('blocker-end');
    });
    await blockerRunning.promise;

    const hbPromises: Array<Promise<void>> = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      hbPromises.push(sem.run('heartbeat', async () => {
        order.push(`hb${idx}`);
      }));
    }

    // Let the heartbeats settle into the queue before the user job arrives.
    await Promise.resolve();

    const pUser = sem.run('user', async () => {
      order.push('user');
    });

    blockerDone.resolve();
    await pBlocker;
    await pUser;
    await Promise.all(hbPromises);

    expect(order).toEqual(['blocker-start', 'blocker-end', 'user', 'hb0', 'hb1', 'hb2', 'hb3', 'hb4']);
  });

  it('rejects a user enqueue once the bounded user queue is full', async () => {
    const SemaphoreWithOptions = LLMSemaphore as unknown as new (options: {
      maxQueuedUsers: number;
      maxQueuedHeartbeats: number;
      maxQueuedBackground: number;
    }) => LLMSemaphore;
    const bounded = new SemaphoreWithOptions({ maxQueuedUsers: 1, maxQueuedHeartbeats: 10, maxQueuedBackground: 20 });
    const blockerRunning = deferred();
    const blockerDone = deferred();
    const blocker = bounded.run('user', async () => {
      blockerRunning.resolve();
      await blockerDone.promise;
    });
    await blockerRunning.promise;

    const queued = bounded.run('user', async () => {});
    const overflow = bounded.run('user', async () => {});

    blockerDone.resolve();
    await blocker;
    await expect(overflow).rejects.toMatchObject({ name: 'UserQueueFullError' });
    await queued;
  });

  it('rejects a background enqueue once the bounded background queue is full', async () => {
    const SemaphoreWithOptions = LLMSemaphore as unknown as new (options: {
      maxQueuedUsers: number;
      maxQueuedHeartbeats: number;
      maxQueuedBackground: number;
    }) => LLMSemaphore;
    const bounded = new SemaphoreWithOptions({ maxQueuedUsers: 100, maxQueuedHeartbeats: 10, maxQueuedBackground: 1 });
    const blockerRunning = deferred();
    const blockerDone = deferred();
    const blocker = bounded.run('user', async () => {
      blockerRunning.resolve();
      await blockerDone.promise;
    });
    await blockerRunning.promise;

    const queued = bounded.run('background', async () => {});
    const overflow = bounded.run('background', async () => {});

    blockerDone.resolve();
    await blocker;
    await expect(overflow).rejects.toMatchObject({ name: 'BackgroundQueueFullError' });
    await queued;
  });

  it('shutdown rejects queued work with a typed error and does not run it', async () => {
    const blockerRunning = deferred();
    const blockerDone = deferred();
    const order: string[] = [];
    const blocker = sem.run('user', async () => {
      order.push('blocker');
      blockerRunning.resolve();
      await blockerDone.promise;
    });
    await blockerRunning.promise;

    const queuedUser = sem.run('user', async () => { order.push('queued-user'); });
    const queuedHeartbeat = sem.run('heartbeat', async () => { order.push('queued-heartbeat'); });
    const queuedBackground = sem.run('background', async () => { order.push('queued-background'); });

    try {
      (sem as unknown as { shutdown(): void }).shutdown();

      await expect(queuedUser).rejects.toMatchObject({ name: 'SemaphoreShutdownError' });
      await expect(queuedHeartbeat).rejects.toMatchObject({ name: 'SemaphoreShutdownError' });
      await expect(queuedBackground).rejects.toMatchObject({ name: 'SemaphoreShutdownError' });
    } finally {
      blockerDone.resolve();
      await blocker;
    }
    expect(order).toEqual(['blocker']);
  });

  it('allows a waiting background job to run after a bounded burst of users', async () => {
    const blockerRunning = deferred();
    const blockerDone = deferred();
    const order: string[] = [];
    const blocker = sem.run('user', async () => {
      order.push('blocker');
      blockerRunning.resolve();
      await blockerDone.promise;
    });
    await blockerRunning.promise;

    const background = sem.run('background', async () => { order.push('background'); });
    const users = Array.from({ length: 9 }, (_, i) => sem.run('user', async () => { order.push(`user-${i}`); }));

    blockerDone.resolve();
    await blocker;
    await background;
    await Promise.all(users);

    expect(order.indexOf('background')).toBeGreaterThan(0);
    expect(order.indexOf('background')).toBeLessThan(order.indexOf('user-8'));
  });

  it('allows a waiting background job to run after a bounded burst of heartbeats', async () => {
    const SemaphoreWithOptions = LLMSemaphore as unknown as new (options: {
      maxQueuedUsers: number;
      maxQueuedHeartbeats: number;
      maxQueuedBackground: number;
      maxConsecutiveUserJobsWithBackground: number;
    }) => LLMSemaphore;
    const bounded = new SemaphoreWithOptions({
      maxQueuedUsers: 100,
      maxQueuedHeartbeats: 10,
      maxQueuedBackground: 1,
      maxConsecutiveUserJobsWithBackground: 2,
    });
    const blockerRunning = deferred();
    const blockerDone = deferred();
    const order: string[] = [];
    const blocker = bounded.run('user', async () => {
      order.push('blocker');
      blockerRunning.resolve();
      await blockerDone.promise;
    });
    await blockerRunning.promise;

    const background = bounded.run('background', async () => { order.push('background'); });
    const heartbeats = Array.from({ length: 3 }, (_, i) =>
      bounded.run('heartbeat', async () => { order.push(`heartbeat-${i}`); }));

    blockerDone.resolve();
    await blocker;
    await background;
    await Promise.all(heartbeats);

    expect(order.indexOf('background')).toBeLessThan(order.indexOf('heartbeat-2'));
  });
});
