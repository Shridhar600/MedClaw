import type { ProviderConfig } from '../config';

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
  /** The only path the owner chooses: workspace, stores and the owner record all derive from it. */
  stateRoot: string;
  /** Owner identity, validated with the config decoder's grammar. */
  ownerId: string;
  provider: ProviderConfig['type'];
  mainModel: string;
  medicalModel: string;
  /** Explicit medical selection survives the wizard; absent means the local default. */
  medicalProvider?: ProviderConfig['type'];
  medicalApiKey?: string;
  /** Independent of `provider`: a cloud main provider must not silently move embeddings to cloud. */
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
