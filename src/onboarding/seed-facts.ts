import type { OnboardingAnswers } from './types';

/** One structured fact taken from an onboarding answer. */
export interface SeedFact {
  entity: string;
  type: 'condition' | 'medication' | 'allergy';
  fields: Record<string, string | string[]>;
}

const NONE_ANSWER = /^(none|no|nope|nil|nothing|n\/?a|-|no known( \w+)?|none known|not really)$/i;

/** Split a free-text list answer into items: commas, semicolons, new lines and "and". */
function listItems(answer: string | undefined): string[] {
  if (!answer || NONE_ANSWER.test(answer.trim())) return [];
  return answer
    .split(/[,;\n]|\band\b/i)
    .map((item) => item.trim().replace(/\.$/, ''))
    .filter((item) => item !== '' && !NONE_ANSWER.test(item));
}

/** "Metformin 500mg twice daily" → metformin + dose; the name is the words before the first number. */
function medication(item: string): SeedFact {
  const words = item.split(/\s+/);
  const firstNumber = words.findIndex((word) => /^\d/.test(word));
  const name = (firstNumber > 0 ? words.slice(0, firstNumber) : words).join(' ');
  const dose = firstNumber > 0 ? words.slice(firstNumber).join(' ') : '';
  return {
    entity: name.toLowerCase(),
    type: 'medication',
    fields: { ...(dose ? { dose } : {}), known_side_effects: [] },
  };
}

/** "penicillin (hives)" or "penicillin - hives" → penicillin + reaction. */
function allergy(item: string): SeedFact {
  const match = item.match(/^([^(:-]+?)\s*(?:\((.+)\)|[-:]\s*(.+))?$/);
  const name = (match?.[1] ?? item).trim();
  const reaction = (match?.[2] ?? match?.[3] ?? '').trim();
  return { entity: name.toLowerCase(), type: 'allergy', fields: reaction ? { reaction } : {} };
}

/** The structured facts in an owner's onboarding answers. Deterministic; no model call. */
export function onboardingSeedFacts(answers: OnboardingAnswers): SeedFact[] {
  return [
    ...listItems(answers.conditions).map((item): SeedFact => ({ entity: item.toLowerCase(), type: 'condition', fields: {} })),
    ...listItems(answers.medications).map(medication),
    ...listItems(answers.allergies).map(allergy),
  ].filter((fact) => fact.entity !== '');
}
