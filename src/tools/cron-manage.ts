import type { Tool, ToolExecutionContext, ToolResult } from './types';
import { HeartbeatScheduler } from '../scheduler/runtime';
import { syncHeartbeatMarkdown } from '../scheduler/heartbeat-markdown';

type CronManageAction = 'create' | 'list' | 'delete' | 'pause' | 'resume';

function toError(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function createCronManageTool(
  scheduler: HeartbeatScheduler,
  workspacePath: string,
): Tool {
  return {
    name: 'cron_manage',
    group: 'group:automation',
    description: 'Create, list, pause, resume, or delete proactive heartbeat jobs. USE THIS whenever the user asks for a reminder, check-in, or recurring nudge (e.g. "remind me to take my medicine daily") — never just promise a reminder in words; schedule it here so it actually fires.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'delete', 'pause', 'resume'] },
        id: { type: 'string' },
        title: { type: 'string' },
        chatId: { type: 'string' },
        cron: { type: 'string' },
        timezone: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['action'],
    },
    async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
      const action = asString(params.action) as CronManageAction | undefined;
      if (!action) {
        return toError('cron_manage requires a valid action.');
      }

      try {
        if (action === 'list') {
          const jobs = await scheduler.listJobs();
          if (jobs.length === 0) {
            return { content: [{ type: 'text', text: 'No heartbeat jobs configured.' }] };
          }
          const lines = jobs.map((job) => `${job.id} | ${job.title} | ${job.cron} | ${job.enabled ? 'enabled' : 'paused'}`);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (action === 'create') {
          const title = asString(params.title);
          const chatId = asString(params.chatId) ?? asString(context?.chatId);
          const cron = asString(params.cron);
          const prompt = asString(params.prompt);
          const timezone = asString(params.timezone);
          if (!title || !chatId || !cron || !prompt) {
            return toError('create requires title, chatId, cron, and prompt.');
          }

          const created = await scheduler.createJob({
            title,
            chatId,
            cron,
            timezone,
            prompt,
            source: 'agent',
            kind: 'routine',
          });
          await syncHeartbeatMarkdown(workspacePath, await scheduler.listJobs());
          return {
            content: [{ type: 'text', text: `Created heartbeat job "${created.title}" (id: ${created.id}).` }],
          };
        }

        const id = asString(params.id);
        if (!id) {
          return toError(`${action} requires id.`);
        }

        if (action === 'pause') {
          const paused = await scheduler.pause(id);
          await syncHeartbeatMarkdown(workspacePath, await scheduler.listJobs());
          return { content: [{ type: 'text', text: `Paused heartbeat job "${paused.title}" (id: ${paused.id}).` }] };
        }

        if (action === 'resume') {
          const resumed = await scheduler.resume(id);
          await syncHeartbeatMarkdown(workspacePath, await scheduler.listJobs());
          return { content: [{ type: 'text', text: `Resumed heartbeat job "${resumed.title}" (id: ${resumed.id}).` }] };
        }

        const deleted = await scheduler.deleteJob(id);
        if (!deleted) {
          return toError(`Heartbeat job not found: ${id}`);
        }
        await syncHeartbeatMarkdown(workspacePath, await scheduler.listJobs());
        return { content: [{ type: 'text', text: `Deleted heartbeat job ${id}.` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toError(`cron_manage failed: ${message}`);
      }
    },
  };
}
