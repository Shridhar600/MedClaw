import type { Tool, ToolResult } from './types';
import { HeartbeatScheduler } from '../scheduler/runtime';
import { syncHeartbeatMarkdown } from '../scheduler/heartbeat-markdown';

type HeartbeatManageAction =
  | 'list'
  | 'inspect'
  | 'snooze'
  | 'ack'
  | 'retry'
  | 'resume'
  | 'dead_letter_list';

function toError(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function formatJob(job: Awaited<ReturnType<HeartbeatScheduler['listJobs']>>[number]): string {
  return [
    `id: ${job.id}`,
    `title: ${job.title}`,
    `chatId: ${job.chatId}`,
    `deliveryState: ${job.deliveryState}`,
    `enabled: ${job.enabled}`,
    `retryCount: ${job.retryCount}/${job.maxRetries}`,
    `nextRetryAt: ${job.nextRetryAt ?? '(none)'}`,
    `snoozedUntil: ${job.snoozedUntil ?? '(none)'}`,
    `acknowledgedAt: ${job.acknowledgedAt ?? '(none)'}`,
    `deadLetterReason: ${job.deadLetterReason ?? '(none)'}`,
  ].join('\n');
}

function formatAuditEvents(
  events: Awaited<ReturnType<HeartbeatScheduler['readAuditEvents']>>,
): string {
  if (events.length === 0) {
    return 'Recent audit events:\n- (none)';
  }
  const lines = events.map((event) => `- ${event.at} ${event.type}`);
  return ['Recent audit events:', ...lines].join('\n');
}

export function createHeartbeatManageTool(
  scheduler: HeartbeatScheduler,
  workspacePath: string,
  now: () => Date = () => new Date(),
): Tool {
  return {
    name: 'heartbeat_manage',
    group: 'group:automation',
    description: 'Inspect, snooze, acknowledge, retry, resume, or review dead-letter heartbeat runtime state. For scheduling NEW recurring reminders or check-ins, use cron_manage instead — never just promise a reminder in words.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'inspect', 'snooze', 'ack', 'retry', 'resume', 'dead_letter_list'],
        },
        id: { type: 'string' },
        until: { type: 'string' },
      },
      required: ['action'],
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = asString(params.action) as HeartbeatManageAction | undefined;
      if (!action) {
        return toError('heartbeat_manage requires a valid action.');
      }

      try {
        if (action === 'list') {
          const jobs = await scheduler.listJobs();
          if (jobs.length === 0) {
            return { content: [{ type: 'text', text: 'No heartbeat jobs configured.' }] };
          }
          const lines = jobs.map((job) => `${job.id} | ${job.title} | ${job.deliveryState} | ${job.enabled ? 'enabled' : 'paused'}`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (action === 'dead_letter_list') {
          const jobs = (await scheduler.listJobs()).filter((job) => job.deliveryState === 'dead-letter');
          if (jobs.length === 0) {
            return { content: [{ type: 'text', text: 'No dead-letter heartbeat jobs.' }] };
          }
          return { content: [{ type: 'text', text: jobs.map((job) => formatJob(job)).join('\n\n') }] };
        }

        const id = asString(params.id);
        if (!id) {
          return toError(`${action} requires id.`);
        }

        const current = await scheduler.getStore().get(id);
        if (!current) {
          return toError(`Heartbeat job not found: ${id}`);
        }

        if (action === 'inspect') {
          const events = await scheduler.readAuditEvents(id, 5);
          return { content: [{ type: 'text', text: `${formatJob(current)}\n\n${formatAuditEvents(events)}` }] };
        }

        if (action === 'snooze') {
          const until = asString(params.until);
          if (!until) {
            return toError('snooze requires until.');
          }
          await scheduler.updateJob(id, {
            deliveryState: 'snoozed',
            snoozedUntil: until,
          });
          await syncHeartbeatMarkdown(workspacePath, await scheduler.listJobs());
          return { content: [{ type: 'text', text: `Snoozed heartbeat job "${current.title}" until ${until}.` }] };
        }

        if (action === 'ack') {
          const acknowledgedAt = now().toISOString();
          await scheduler.updateJob(id, { acknowledgedAt });
          await syncHeartbeatMarkdown(workspacePath, await scheduler.listJobs());
          return { content: [{ type: 'text', text: `Acknowledged heartbeat job "${current.title}" at ${acknowledgedAt}.` }] };
        }

        if (action === 'retry') {
          await scheduler.updateJob(id, {
            deliveryState: 'ready',
            nextRetryAt: undefined,
            snoozedUntil: undefined,
            deadLetterReason: undefined,
            enabled: true,
          });
          await syncHeartbeatMarkdown(workspacePath, await scheduler.listJobs());
          return { content: [{ type: 'text', text: `Revived heartbeat job "${current.title}" for manual retry.` }] };
        }

        await scheduler.updateJob(id, {
          enabled: true,
          deliveryState: 'ready',
          nextRetryAt: undefined,
          snoozedUntil: undefined,
          deadLetterReason: undefined,
        });
        await syncHeartbeatMarkdown(workspacePath, await scheduler.listJobs());
        return { content: [{ type: 'text', text: `Resumed heartbeat job "${current.title}".` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toError(`heartbeat_manage failed: ${message}`);
      }
    },
  };
}
