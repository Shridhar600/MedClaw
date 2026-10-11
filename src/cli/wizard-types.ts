import type { ProviderConfig } from '../config';

export type SetupStepId =
  | 'environment'
  | 'state'
  | 'provider'
  | 'embeddings'
  | 'telegram'
  | 'preferences'
  | 'review';

export type ReviewAction =
  | 'apply'
  | 'state'
  | 'provider'
  | 'embeddings'
  | 'telegram'
  | 'preferences'
  | 'cancel';

export type CompletionAction = 'start' | 'review-config' | 'exit';

export interface SetupWizardState {
  configPath: string;
  /**
   * Owner state root — the ONLY path the owner chooses. The workspace, scheduler store, audit log,
   * transcript directory, media staging and owner record are all derived from it plus `ownerId`,
   * so there is no second path authority to disagree with.
   */
  stateRoot: string;
  /** Owner identity, validated with the config decoder's grammar. */
  ownerId: string;
  provider: ProviderConfig['type'];
  mainModel: string;
  medicalModel: string;
  /** Explicit medical selection survives the wizard; absent means the local default. */
  medicalProvider?: ProviderConfig['type'];
  medicalApiKey?: string;
  /**
   * The EMBEDDING role's own selection (plan 15 §2.4). Independent of `provider`: a cloud main
   * provider must not silently move embeddings to cloud. Defaults to the local Ollama role.
   */
  embeddingProvider: ProviderConfig['type'];
  embeddingModel: string;
  /** Explicit endpoint for the embedding role only. Never inherited from the main role. */
  embeddingUrl?: string;
  /** Explicit key for the embedding role only. Never copied from the main role's key. */
  embeddingApiKey?: string;
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
  'state',
  'provider',
  'embeddings',
  'telegram',
  'preferences',
  'review',
];

export const REVIEW_ACTIONS: readonly ReviewAction[] = [
  'apply',
  'state',
  'provider',
  'embeddings',
  'telegram',
  'preferences',
  'cancel',
];

export const COMPLETION_ACTIONS: readonly CompletionAction[] = [
  'start',
  'review-config',
  'exit',
];
