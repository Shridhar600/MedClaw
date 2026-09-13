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
  'kill myself',
  'hurt myself',
  'harm myself',
  'cut myself',
  'cutting myself',
] as const;

export const EMERGENCY_RESPONSE =
  'This may be an emergency. Please contact local emergency services now or go to the nearest emergency department. If you can, ask someone nearby to stay with you while you get help.'
  + MEDICAL_DISCLAIMER;

// RR2-A2: code-owned complete-statement denials. An explicit denial suppresses the
// matching built-in trigger only when the ENTIRE normalized message equals one of
// these forms. This is intentionally conservative: suffixes, second sentences,
// uncertainty, mixed intent, quotations, historical accounts and third-party
// quotations never qualify, so those inputs still escalate. Never treat `not`,
// `don't`, quote marks or a past tense alone as a blanket safety bypass.
const DENIAL_PREFIXES = [
  'I will not',
  "I won't",
  'I do not want to',
  "I don't want to",
  'I am not going to',
  "I'm not going to",
] as const;

const DENIAL_ACTIONS = [
  'kill myself',
  'hurt myself',
  'harm myself',
  'cut myself',
] as const;

const DENIAL_STATEMENTS: readonly string[] = [
  'no chest pain',
  'I have no chest pain',
  'I do not have chest pain',
  "I don't have chest pain",
  'not suicidal',
  'I am not suicidal',
  "I'm not suicidal",
  'I am not cutting myself',
  "I'm not cutting myself",
  ...DENIAL_PREFIXES.flatMap((prefix) => DENIAL_ACTIONS.map((action) => `${prefix} ${action}`)),
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Shared match normalization: curly/primes to ASCII apostrophe, collapse all
// whitespace runs to one space, trim, lowercase. Applied to the input, built-ins,
// configured phrases and denial forms before comparison.
function normalizeForMatch(value: string): string {
  return value
    .replace(/[‘’‛′]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Denial comparison may remove ONE terminal period or exclamation mark, but only
// when it is not part of a punctuation run. Ellipsis, repeated/mixed punctuation,
// quotes, parentheses and question marks are preserved, so those inputs stay
// recognized warnings under the ambiguous-warning posture.
function stripSingleTerminalMark(value: string): string {
  if (value.length < 2) return value;
  const last = value[value.length - 1];
  if (last !== '.' && last !== '!') return value;
  const prev = value[value.length - 2];
  if (prev === '.' || prev === '!' || prev === '?') return value;
  return value.slice(0, -1);
}

function matchesWholeToken(normalizedInput: string, normalizedPhrase: string): boolean {
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(normalizedPhrase)}(?:$|[^a-z0-9])`);
  return pattern.test(normalizedInput);
}

export function isEmergencyInput(input: string, configuredKeywords: readonly unknown[] = []): boolean {
  const normalizedInput = normalizeForMatch(input);
  const normalizedBuiltins = new Set<string>(
    (BUILT_IN_EMERGENCY_KEYWORDS as readonly string[]).map(normalizeForMatch),
  );
  const builtinMatches = [...normalizedBuiltins].filter((keyword) =>
    matchesWholeToken(normalizedInput, keyword),
  );

  // Independent configured triggers retain precedence: normalized phrases that are
  // not duplicates of a built-in trigger even inside a denial statement.
  // Malformed entries are skipped and regex-looking text keeps literal semantics.
  const seenConfigured = new Set<string>();
  let hasIndependentConfiguredMatch = false;
  for (const value of configuredKeywords) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const phrase = normalizeForMatch(value);
    if (phrase === '' || seenConfigured.has(phrase) || normalizedBuiltins.has(phrase)) continue;
    seenConfigured.add(phrase);
    if (matchesWholeToken(normalizedInput, phrase)) hasIndependentConfiguredMatch = true;
  }

  if (builtinMatches.length === 0 && !hasIndependentConfiguredMatch) return false;
  if (hasIndependentConfiguredMatch) return true;

  const denialCandidate = stripSingleTerminalMark(normalizedInput);
  const isKnownDenial = DENIAL_STATEMENTS.some(
    (statement) => normalizeForMatch(statement) === denialCandidate,
  );
  if (!isKnownDenial) return true;
  // The denial covers the built-in matches in its specified denied phrase
  // (including overlapping `want to kill myself` / `kill myself` matches), not
  // any arbitrary additional trigger.
  const covered = DENIAL_STATEMENTS.filter(
    (statement) => normalizeForMatch(statement) === denialCandidate,
  ).flatMap((statement) =>
    [...normalizedBuiltins].filter((keyword) =>
      matchesWholeToken(normalizeForMatch(statement), keyword),
    ),
  );
  return !builtinMatches.every((match) => covered.includes(match));
}
