export type OnboardingStatus = 'not_started' | 'in_progress' | 'complete' | 'skipped';

export type OnboardingStep =
  | 'welcome'
  | 'name'
  | 'age'
  | 'timezone'
  | 'conditions'
  | 'medications'
  | 'allergies'
  | 'goals'
  | 'reminders'
  | 'confirmation';

export interface OnboardingAnswers {
  name?: string;
  age?: string;
  timezone?: string;
  conditions?: string;
  medications?: string;
  allergies?: string;
  goals?: string;
  reminderPreferences?: string;
}

export interface OnboardingState {
  status: OnboardingStatus;
  currentStep: OnboardingStep;
  answers: OnboardingAnswers;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  disclaimerShownAt?: string;
}

export interface OnboardingResult {
  response: string;
  bypass?: boolean;
  completed?: boolean;
}
