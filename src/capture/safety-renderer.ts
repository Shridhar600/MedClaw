
import type { LedgerFact } from '../memcore';
import type { SafetyRenderer } from './pipeline';
import { summarizeErrorForLog } from '../security';

export interface SafetyRendererSource {
  render(facts: LedgerFact[]): Promise<string>;
  /** The FULL safety-relevant source set — active + resolved + disputed. */
  listSafetyRelevant(): Promise<LedgerFact[]>;
  markDirty?(): void;
}

export function makeSafetyRenderer(source: SafetyRendererSource): SafetyRenderer {
  const adapter: SafetyRenderer = {
    render: async facts => {
      try {
        return await source.render(facts);
      } catch (e) {
        try {
          source.markDirty?.();
        } catch (markError) {
          // A marker failure must not replace the original publication error.
          console.warn('[capture] SAFETY dirty marker failed:', summarizeErrorForLog(markError));
        }
        throw e;
      }
    },
    listSafetyRelevant: () => source.listSafetyRelevant(),
  };
  if (source.markDirty) adapter.markDirty = () => source.markDirty?.();
  return adapter;
}
