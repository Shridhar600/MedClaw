import { writeOnboardingProfile } from './profile-writer';
import { OnboardingStore } from './store';
import type { OnboardingAnswers, OnboardingResult, OnboardingState, OnboardingStep } from './types';

const EMERGENCY_PATTERN =
  /\b(chest pain|can't breathe|cannot breathe|difficulty breathing|stroke|heart attack|severe bleeding|suicidal|emergency)\b/i;
const SKIP_PATTERN = /^(skip|later)$/i;
const CONFIRM_PATTERN = /^(confirm|yes|y)\b/i;

export class OnboardingFlow {
  constructor(
    private readonly store: OnboardingStore,
    private readonly workspacePath: string,
    private readonly defaultTimezone: string,
  ) {}

  async isComplete(): Promise<boolean> {
    return (await this.store.load()).status === 'complete' || (await this.store.load()).status === 'skipped';
  }

  async handle(input: string): Promise<OnboardingResult> {
    const cleanInput = sanitizeOnboardingInput(input);
    if (EMERGENCY_PATTERN.test(cleanInput)) {
      return {
        bypass: true,
        response:
          'This may be an emergency. Please contact local emergency services now or go to the nearest emergency department. If you can, ask someone nearby to stay with you while you get help.',
      };
    }

    const state = await this.store.load();
    if (/^restart onboarding$/i.test(cleanInput)) {
      return this.startFresh();
    }
    if (SKIP_PATTERN.test(cleanInput)) {
      const now = new Date().toISOString();
      await this.store.save({ ...state, status: 'skipped', updatedAt: now, completedAt: now });
      return {
        completed: true,
        response: 'Onboarding is skipped for now. You can restart it later with /onboarding restart.',
      };
    }

    if (state.status === 'complete' || state.status === 'skipped') {
      return { completed: true, response: '' };
    }
    if (state.status === 'not_started') {
      return this.startFresh();
    }

    return this.acceptStepAnswer(state, cleanInput);
  }

  private async startFresh(): Promise<OnboardingResult> {
    const now = new Date().toISOString();
    await this.store.save({
      status: 'in_progress',
      currentStep: 'name',
      answers: { timezone: this.defaultTimezone },
      startedAt: now,
      updatedAt: now,
      disclaimerShownAt: now,
    });
    return {
      response:
        'Before we start: I am a personal health companion, not a doctor, and I cannot diagnose or replace emergency care. What is your preferred name?',
    };
  }

  private async acceptStepAnswer(state: OnboardingState, answer: string): Promise<OnboardingResult> {
    const answers = sanitizeAnswers(state.answers);
    let nextStep: OnboardingStep = state.currentStep;
    let response: string;

    switch (state.currentStep) {
      case 'name':
        answers.name = answer;
        nextStep = 'age';
        response = 'What is your age or age range?';
        break;
      case 'age':
        answers.age = answer;
        nextStep = 'timezone';
        response = `Please confirm your timezone. I have ${answers.timezone ?? this.defaultTimezone}.`;
        break;
      case 'timezone': {
        // forka #5: don't store the raw phrase as the timezone. Affirmative or
        // empty → keep the offered default. Otherwise accept the answer only if
        // it is a valid IANA zone; if it's a phrase like "yes Asia/Kolkata is
        // right", recover the valid zone token from it; else keep the default.
        const trimmed = answer.trim();
        const fallback = answers.timezone ?? this.defaultTimezone;
        if (isAffirmative(trimmed) || trimmed === '') {
          answers.timezone = fallback;
        } else if (isValidTimezone(trimmed)) {
          answers.timezone = trimmed;
        } else {
          answers.timezone = trimmed.split(/\s+/).find(isValidTimezone) ?? fallback;
        }
        nextStep = 'conditions';
        response = 'Any major health conditions I should remember?';
        break;
      }
      case 'conditions':
        answers.conditions = answer;
        nextStep = 'medications';
        response = 'What current medications or supplements should I remember?';
        break;
      case 'medications':
        answers.medications = answer;
        nextStep = 'allergies';
        response = 'Any medication, food, or other allergies?';
        break;
      case 'allergies':
        answers.allergies = answer;
        nextStep = 'goals';
        response = 'What are your main health goals?';
        break;
      case 'goals':
        answers.goals = answer;
        nextStep = 'reminders';
        response = 'What reminder preferences should I use for check-ins, medications, or routines?';
        break;
      case 'reminders':
        answers.reminderPreferences = answer;
        nextStep = 'confirmation';
        response = this.renderConfirmation(answers);
        break;
      case 'confirmation':
        if (!CONFIRM_PATTERN.test(answer)) {
          response = 'Reply confirm to save this profile, or restart onboarding to begin again.';
          break;
        }
        await writeOnboardingProfile(this.workspacePath, answers);
        await this.store.save({
          ...state,
          status: 'complete',
          currentStep: 'confirmation',
          answers,
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
        return {
          completed: true,
          response: 'Your onboarding is complete. I saved this profile locally and can now answer normally.',
        };
      default:
        nextStep = 'name';
        response = 'What is your preferred name?';
    }

    await this.store.save({
      ...state,
      status: 'in_progress',
      currentStep: nextStep,
      answers,
      updatedAt: new Date().toISOString(),
    });
    return { response };
  }

  private renderConfirmation(answers: OnboardingAnswers): string {
    return [
      'Here is what I captured:',
      `Name: ${answers.name ?? 'None recorded'}`,
      `Age: ${answers.age ?? 'None recorded'}`,
      `Timezone: ${answers.timezone ?? this.defaultTimezone}`,
      `Conditions: ${answers.conditions ?? 'None recorded'}`,
      `Medications: ${answers.medications ?? 'None recorded'}`,
      `Allergies: ${answers.allergies ?? 'None recorded'}`,
      `Goals: ${answers.goals ?? 'None recorded'}`,
      `Reminders: ${answers.reminderPreferences ?? 'None recorded'}`,
      'Reply confirm to save this profile.',
    ].join('\n');
  }
}

function sanitizeAnswers(answers: OnboardingAnswers): OnboardingAnswers {
  const cleaned: OnboardingAnswers = {};
  for (const [key, value] of Object.entries(answers)) {
    cleaned[key as keyof OnboardingAnswers] = value === undefined ? undefined : sanitizeOnboardingInput(value);
  }
  return cleaned;
}

function sanitizeOnboardingInput(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !/^\s*(user id|reply to message id|uploaded media path)\s*:/i.test(line))
    .join('\n')
    .trim();
}

function isAffirmative(input: string): boolean {
  return /^(yes|y|correct|confirm|ok|okay)$/i.test(input.trim());
}

// forka #5: validate an IANA timezone without a dependency — Intl throws a
// RangeError for an unknown zone.
function isValidTimezone(tz: string): boolean {
  if (!tz || /\s/.test(tz)) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
