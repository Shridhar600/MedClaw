import { MEDICAL_DISCLAIMER } from './medical-disclaimer';

// Conservative safety net. Favor false positives. This list must receive clinical review
// before MedClaw makes any claim of clinical completeness.
export const BUILT_IN_EMERGENCY_KEYWORDS = [
  'chest pain',
  "can't breathe",
  'cannot breathe',
  'difficulty breathing',
  'not breathing',
  'stroke',
  'heart attack',
  'severe bleeding',
  'suicidal',
  'want to kill myself',
  'want to die',
  "don't want to live",
  "don't want to be alive",
  'end it',
  'end my life',
  'not worth living',
  'took all my pills',
  'overdose',
  'overdosed',
  'self-harm',
  'self harm',
  'unconscious',
  'unresponsive',
  'anaphylaxis',
  'seizure',
  'emergency',
] as const;

export const EMERGENCY_RESPONSE =
  'This may be an emergency. Please contact local emergency services now or go to the nearest emergency department. If you can, ask someone nearby to stay with you while you get help.'
  + MEDICAL_DISCLAIMER;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isEmergencyInput(input: string, configuredKeywords: readonly unknown[] = []): boolean {
  const keywords = new Set<string>(BUILT_IN_EMERGENCY_KEYWORDS);
  for (const value of configuredKeywords) {
    if (typeof value === 'string' && value.trim() !== '') keywords.add(value.trim().toLowerCase());
  }
  return [...keywords].some((keyword) => {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(keyword)}(?:$|[^a-z0-9])`, 'i');
    return pattern.test(input);
  });
}
