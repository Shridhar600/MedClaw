import type { CreateHeartbeatJobInput } from './types';
import { HeartbeatScheduler } from './runtime';

interface ReconcilePolicyJobsResult {
  created: number;
  updated: number;
  deleted: number;
}

function isDuplicatePolicyKeyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Duplicate heartbeat policy key:');
}

function isInvalidCronError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Invalid cron:');
}

function hasJobChanged(existing: CreateHeartbeatJobInput, desired: CreateHeartbeatJobInput): boolean {
  return (
    existing.title !== desired.title ||
    existing.chatId !== desired.chatId ||
    existing.cron !== desired.cron ||
    existing.timezone !== desired.timezone ||
    existing.prompt !== desired.prompt ||
    existing.kind !== desired.kind ||
    existing.policyKey !== desired.policyKey
  );
}

export async function reconcilePolicyJobs(
  scheduler: HeartbeatScheduler,
  desiredJobs: CreateHeartbeatJobInput[],
): Promise<ReconcilePolicyJobsResult> {
  let created = 0;
  let updated = 0;
  let deleted = 0;

  const desiredByPolicyKey = new Map<string, CreateHeartbeatJobInput>();
  for (const desired of desiredJobs) {
    if (desired.source !== 'system' || !desired.policyKey) {
      continue;
    }
    desiredByPolicyKey.set(desired.policyKey, desired);
  }

  const existingJobs = await scheduler.listJobs();
  const existingSystemPolicyJobs = existingJobs.filter((job) => job.source === 'system' && !!job.policyKey);

  for (const desired of desiredByPolicyKey.values()) {
    try {
      await scheduler.createJob({
        title: desired.title,
        chatId: desired.chatId,
        cron: desired.cron,
        timezone: desired.timezone,
        prompt: desired.prompt,
        source: desired.source,
        kind: desired.kind,
        policyKey: desired.policyKey,
      });
      created += 1;
      continue;
    } catch (error) {
      if (isInvalidCronError(error)) {
        continue;
      }
      if (!isDuplicatePolicyKeyError(error)) {
        throw error;
      }
    }

    const existing = existingSystemPolicyJobs.find((job) => job.policyKey === desired.policyKey);
    if (!existing) {
      continue;
    }

    const comparable = {
      title: existing.title,
      chatId: existing.chatId,
      cron: existing.cron,
      timezone: existing.timezone,
      prompt: existing.prompt,
      source: existing.source,
      kind: existing.kind,
      policyKey: existing.policyKey,
    } as CreateHeartbeatJobInput;

    if (!hasJobChanged(comparable, desired)) {
      continue;
    }

    try {
      await scheduler.updateJob(existing.id, {
        title: desired.title,
        chatId: desired.chatId,
        cron: desired.cron,
        timezone: desired.timezone,
        prompt: desired.prompt,
        source: desired.source,
        kind: desired.kind,
        policyKey: desired.policyKey,
      });
      updated += 1;
    } catch (error) {
      if (isInvalidCronError(error)) {
        continue;
      }
      throw error;
    }
  }

  for (const existing of existingSystemPolicyJobs) {
    if (existing.policyKey && desiredByPolicyKey.has(existing.policyKey)) {
      continue;
    }
    const removed = await scheduler.deleteJob(existing.id);
    if (removed) {
      deleted += 1;
    }
  }

  return { created, updated, deleted };
}
