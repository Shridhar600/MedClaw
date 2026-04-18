import type { HeartbeatPolicyConfig } from '../config/types';
import type { CreateHeartbeatJobInput, HeartbeatJobKind } from './types';
import { readPolicySourceRecords } from './policy-sources';

export interface BuildDesiredHeartbeatJobsInput {
  workspacePath: string;
  chatId: string;
  timezone: string;
  policy: HeartbeatPolicyConfig;
}

function buildDefaultRoutineJobs(input: BuildDesiredHeartbeatJobsInput): CreateHeartbeatJobInput[] {
  const jobs: CreateHeartbeatJobInput[] = [];

  if (input.policy.defaults.morningCheckIn.enabled) {
    jobs.push({
      title: 'Morning check-in',
      chatId: input.chatId,
      cron: input.policy.defaults.morningCheckIn.cron,
      timezone: input.timezone,
      prompt: input.policy.defaults.morningCheckIn.prompt,
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
    });
  }

  if (input.policy.defaults.eveningSummary.enabled) {
    jobs.push({
      title: 'Evening summary',
      chatId: input.chatId,
      cron: input.policy.defaults.eveningSummary.cron,
      timezone: input.timezone,
      prompt: input.policy.defaults.eveningSummary.prompt,
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:evening-summary',
    });
  }

  return jobs;
}

async function buildWorkspaceDerivedJobs(
  input: BuildDesiredHeartbeatJobsInput,
  dirName: 'medications' | 'conditions' | 'goals',
  kind: HeartbeatJobKind,
): Promise<CreateHeartbeatJobInput[]> {
  const records = await readPolicySourceRecords(input.workspacePath, dirName);
  return records.map((record) => ({
    title: record.title,
    chatId: input.chatId,
    cron: record.cron,
    timezone: record.timezone ?? input.timezone,
    prompt: record.prompt,
    source: 'system',
    kind,
    policyKey: `${dirName}:${record.relativePath}`,
  }));
}

export async function buildDesiredHeartbeatJobs(
  input: BuildDesiredHeartbeatJobsInput,
): Promise<CreateHeartbeatJobInput[]> {
  return [
    ...buildDefaultRoutineJobs(input),
    ...(await buildWorkspaceDerivedJobs(input, 'medications', 'medication')),
    ...(await buildWorkspaceDerivedJobs(input, 'conditions', 'recovery')),
    ...(await buildWorkspaceDerivedJobs(input, 'goals', 'goal')),
  ];
}
