// src/tools/safety-tools.ts
//
// safety_note (Task 12.5) — the agent's SAFETY.md surface. Adding a Critical Event is
// always allowed (add-only). Removing a base allergy/medication is NOT done here: it is
// refused and routed to ledger_update, so the change goes through the ledger (confirmation
// + D8 re-render). CONTRA-03/04.

import type { Tool, ToolResult } from './types';
import type { SafetyView } from '../memcore';

export interface SafetyToolsDeps {
  safetyView: SafetyView;
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
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add-critical-event', 'propose-removal'], description: 'Operation' },
        summary: { type: 'string', description: 'Critical event summary (action=add-critical-event)' },
        action_taken: { type: 'string', description: 'What was advised/done (action=add-critical-event)' },
        date: { type: 'string', description: 'Event date for your bookkeeping — NEVER written into SAFETY.md (C6a)' },
        entity: { type: 'string', description: 'Entity to propose for removal (action=propose-removal)' },
      },
      required: ['action'],
    },
    async execute(params): Promise<ToolResult> {
      const action = params.action as string;

      if (action === 'add-critical-event') {
        const summary = params.summary as string | undefined;
        if (!summary) return err('safety_note add-critical-event needs a summary.');
        await deps.safetyView.addCriticalEvent({
          date: (params.date as string) ?? '',
          summary,
          action: params.action_taken as string | undefined,
        });
        return ok(`Added critical event to SAFETY.md: ${summary}`);
      }

      if (action === 'propose-removal') {
        const entity = (params.entity as string) ?? 'this entry';
        return err(
          `Removing "${entity}" from SAFETY.md is refused here (CONTRA-03/04). SAFETY.md is a rendered view of the ledger — retract or discontinue "${entity}" via ledger_record, then confirm with ledger_update. SAFETY.md will update automatically (D8).`,
        );
      }

      return err(`Unknown safety_note action "${action}".`);
    },
  };

  return [safetyNote];
}
