import * as fs from 'fs';
import * as path from 'path';
import type { HeartbeatJob } from './types';

function formatJob(job: HeartbeatJob): string {
  return `- ${job.title} | ${job.cron} | ${job.timezone} | ${job.enabled ? 'enabled' : 'paused'} | ${job.prompt}`;
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
