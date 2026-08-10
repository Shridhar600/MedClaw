import type { ProviderConfig } from '../config/types';

export type SetupStepId =
  | 'environment'
  | 'workspace'
  | 'provider'
  | 'telegram'
  | 'preferences'
  | 'review';

export type ReviewAction =
  | 'apply'
  | 'workspace'
  | 'provider'
  | 'telegram'
  | 'preferences'
  | 'cancel';

export type CompletionAction = 'start' | 'review-config' | 'exit';

export interface SetupWizardState {
  configPath: string;
  workspace: string;
  provider: ProviderConfig['type'];
  mainModel: string;
  medicalModel: string;
  embeddingModel: string;
  ollamaUrl?: string;
  apiKey?: string;
  telegramEnabled: boolean;
  telegramToken?: string;
  timezone: string;
  heartbeatsEnabled: boolean;
}

export interface SummaryRow {
  label: string;
  value: string;
  secret?: boolean;
}

export const SETUP_STEP_ORDER: readonly SetupStepId[] = [
  'environment',
  'workspace',
  'provider',
  'telegram',
  'preferences',
  'review',
];

export const REVIEW_ACTIONS: readonly ReviewAction[] = [
  'apply',
  'workspace',
  'provider',
  'telegram',
  'preferences',
  'cancel',
];

export const COMPLETION_ACTIONS: readonly CompletionAction[] = [
  'start',
  'review-config',
  'exit',
];
