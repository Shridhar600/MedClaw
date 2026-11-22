
import type { Tool, ToolResult } from './types';
import type { SafetyView } from '../memcore';
import type { QueuePort } from '../capture';
import { contentContainsCredentials } from '../security';

export interface SafetyToolsDeps {
  safetyView: SafetyView;
  /** Serializes appends against concurrent SAFETY.md read-modify-write so an add-only event is never lost. */
  queue?: QueuePort;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createSafetyTools(deps: SafetyToolsDeps): Tool[] {
  const safetyNote: Tool = {
    name: 'safety_note',
    group: 'group:safety',
    description: 'Manage SAFETY.md: add a Critical Event (always allowed), or propose removing a base safety entry (refused here — route through ledger_update).',
    ownerTurnOnly: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add-critical-event', 'propose-removal'], description: 'Operation' },
        summary: { type: 'string', description: 'Critical event summary (action=add-critical-event)' },
        action_taken: { type: 'string', description: 'What was advised/done (action=add-critical-event)' },
        date: { type: 'string', description: 'Event date for your bookkeeping — NEVER written into SAFETY.md' },
        entity: { type: 'string', description: 'Entity to propose for removal (action=propose-removal)' },
      },
      required: ['action'],
    },
    async execute(params): Promise<ToolResult> {
      const action = params.action as string;

      if (action === 'add-critical-event') {
        const summary = params.summary as string | undefined;
        if (!summary) return err('safety_note add-critical-event needs a summary.');
        const actionTaken = params.action_taken as string | undefined;
        const credScan = contentContainsCredentials(`${summary}\n${actionTaken ?? ''}`);
        if (credScan.matched) {
          return err(`Write rejected: content matches credential pattern (${credScan.pattern}). Credentials must never be stored in SAFETY.md.`);
        }
        const addEvent = (): Promise<string> => deps.safetyView.addCriticalEvent({
          date: (params.date as string) ?? '',
          summary,
          action: actionTaken,
        });
        await (deps.queue
          ? deps.queue.enqueue('turn', { label: 'safety:add-critical-event', scope: 'safety', run: addEvent })
          : addEvent());
        return ok(`Added critical event to SAFETY.md: ${summary}`);
      }

      if (action === 'propose-removal') {
        const entity = (params.entity as string) ?? 'this entry';
        return err(
          `Removing "${entity}" from SAFETY.md is refused here. SAFETY.md is a rendered view of the ledger — remove the fact with ledger_remove (entity="${entity}", type=<fact type>), which asks the user to confirm, then updates SAFETY.md automatically on confirm.`,
        );
      }

      return err(`Unknown safety_note action "${action}".`);
    },
  };

  return [safetyNote];
}
