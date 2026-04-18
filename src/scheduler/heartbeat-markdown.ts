import * as fs from 'fs';
import * as path from 'path';
import type { HeartbeatJob } from './types';

function formatJob(job: HeartbeatJob): string {
  return [
    `- ${job.title}`,
    `  kind: ${job.kind}`,
    `  source: ${job.source}`,
    `  cron: ${job.cron}`,
    `  timezone: ${job.timezone}`,
    `  status: ${job.enabled ? 'enabled' : 'paused'}`,
    `  policyKey: ${job.policyKey ?? '(manual)'}`,
    `  lastOutcome: ${job.lastOutcome ?? '(never-run)'}`,
    `  prompt: ${job.prompt}`,
  ].join('\n');
}

export async function syncHeartbeatMarkdown(
  workspacePath: string,
  jobs: HeartbeatJob[],
): Promise<void> {
  const lines = [
    '# Heartbeat Schedule',
    '',
    'Current runtime status:',
    '- Scheduler runtime is active when `heartbeat.enabled` is true and a channel is available.',
    '- This file is a synchronized summary of durable heartbeat jobs.',
    '',
    '## Jobs',
  ];

  if (jobs.length === 0) {
    lines.push('- (none)');
  } else {
    for (const job of jobs) {
      lines.push(formatJob(job));
    }
  }

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'HEARTBEAT.md'), lines.join('\n') + '\n', 'utf8');
}
