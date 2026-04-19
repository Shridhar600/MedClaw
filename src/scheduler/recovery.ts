import type { HeartbeatJob } from './types';

// `node-cron` ships its matcher as CommonJS-only internal code. Reusing it keeps
// recovery aligned with the same cron interpretation used by the live scheduler.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TimeMatcher = require('node-cron/src/time-matcher');

interface FindMostRecentMissedRunInput {
  now: Date;
  windowMinutes: number;
}

function toMinute(date: Date): Date {
  const next = new Date(date.getTime());
  next.setUTCSeconds(0, 0);
  return next;
}

export function findMostRecentMissedRun(
  job: HeartbeatJob,
  input: FindMostRecentMissedRunInput,
): string | undefined {
  if (!job.enabled || input.windowMinutes <= 0 || job.deliveryState !== 'ready') {
    return undefined;
  }

  const matcher = new TimeMatcher(job.cron, job.timezone);
  const latestCandidate = new Date(toMinute(input.now).getTime() - (60 * 1000));
  const earliestCandidate = new Date(latestCandidate.getTime() - (input.windowMinutes * 60 * 1000));
  const lastRunAt = job.lastRunAt ? new Date(job.lastRunAt) : undefined;
  const createdAt = new Date(job.createdAt);

  for (let cursor = latestCandidate.getTime(); cursor >= earliestCandidate.getTime(); cursor -= 60 * 1000) {
    const candidate = new Date(cursor);
    if (candidate.getTime() < createdAt.getTime()) {
      break;
    }
    if (lastRunAt && candidate.getTime() <= lastRunAt.getTime()) {
      break;
    }
    if (matcher.match(candidate)) {
      return candidate.toISOString();
    }
  }

  return undefined;
}
