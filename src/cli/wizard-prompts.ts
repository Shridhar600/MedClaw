import { askHiddenText, askText } from './prompts';
import type { CliIO } from './prompts';
import {
  type CompletionAction,
  type ReviewAction,
} from './wizard-types';

interface MenuOption<TValue extends string> {
  value: TValue;
  label: string;
}

const REVIEW_MENU_OPTIONS: readonly MenuOption<ReviewAction>[] = [
  { value: 'apply', label: 'Apply setup' },
  { value: 'workspace', label: 'Edit workspace' },
  { value: 'provider', label: 'Edit provider' },
  { value: 'telegram', label: 'Edit Telegram' },
  { value: 'preferences', label: 'Edit preferences' },
  { value: 'cancel', label: 'Cancel setup' },
];

const COMPLETION_MENU_OPTIONS: readonly MenuOption<CompletionAction>[] = [
  { value: 'start', label: 'Start MedClaw' },
  { value: 'review-config', label: 'Show config summary' },
  { value: 'exit', label: 'Exit' },
];

export async function askChoice<TChoice extends string>(
  io: CliIO,
  prompt: string,
  options: readonly TChoice[],
  defaultValue: TChoice,
): Promise<TChoice> {
  for (;;) {
    const answer = (await askValue(
      io,
      `${prompt}\n  options: ${options.join(', ')}`,
      defaultValue,
    )).toLowerCase();
    const match = options.find((option) => option.toLowerCase() === answer);
    if (match) {
      return match;
    }
    io.stderr?.(`Invalid choice. Expected one of: ${options.join(', ')}.\n`);
  }
}

export async function askValue(
  io: CliIO,
  prompt: string,
  defaultValue = '',
): Promise<string> {
  const value = await askText(io, prompt, defaultValue);
  return value.trim();
}

export async function askSecret(
  io: CliIO,
  prompt: string,
  defaultValue = '',
): Promise<string> {
  const value = await askHiddenText(io, prompt, defaultValue);
  return value.trim();
}

async function askMenuChoice<TValue extends string>(
  io: CliIO,
  prompt: string,
  options: readonly MenuOption<TValue>[],
  defaultValue: TValue,
): Promise<TValue> {
  const defaultIndex = Math.max(0, options.findIndex((option) => option.value === defaultValue));
  const promptBody = [
    prompt,
    ...options.map((option, index) => `  ${index + 1}. ${option.label}`),
  ].join('\n');

  for (;;) {
    const answer = (await askValue(io, promptBody, String(defaultIndex + 1))).toLowerCase();
    const numericIndex = Number.parseInt(answer, 10);
    if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= options.length) {
      return options[numericIndex - 1].value;
    }

    const match = options.find((option) => option.value === answer);
    if (match) {
      return match.value;
    }
    io.stderr?.(`Invalid choice. Expected one of: ${options.map((option) => option.value).join(', ')}.\n`);
  }
}

export async function askReviewAction(
  io: CliIO,
  defaultValue: ReviewAction = 'apply',
): Promise<ReviewAction> {
  return askMenuChoice(io, 'Review action', REVIEW_MENU_OPTIONS, defaultValue);
}

export async function askCompletionAction(
  io: CliIO,
  defaultValue: CompletionAction = 'exit',
): Promise<CompletionAction> {
  return askMenuChoice(io, 'Next action', COMPLETION_MENU_OPTIONS, defaultValue);
}
