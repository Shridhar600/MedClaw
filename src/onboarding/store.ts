import * as fs from 'fs';
import * as path from 'path';
import { secureWriteViaTmp, tightenFile } from '../security';
import type { OnboardingState } from './types';

const DEFAULT_STATE: OnboardingState = {
  status: 'not_started',
  currentStep: 'welcome',
  answers: {},
};

export class OnboardingStore {
  private readonly filePath: string;

  constructor(private readonly workspacePath: string) {
    this.filePath = path.join(workspacePath, '.redacted', 'onboarding.json');
  }

  async load(): Promise<OnboardingState> {
    if (!fs.existsSync(this.filePath)) {
      return { ...DEFAULT_STATE, answers: {} };
    }

    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) {
      return { ...DEFAULT_STATE, answers: {} };
    }
    try {
      return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<OnboardingState>) };
    } catch (error) {
      this.quarantineCorruptState(error);
      return { ...DEFAULT_STATE, answers: {} };
    }
  }

  async save(state: OnboardingState): Promise<void> {
    secureWriteViaTmp(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private quarantineCorruptState(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, corruptPath);
      tightenFile(corruptPath);
      console.error(`[onboarding] Corrupt onboarding state recovered: ${reason}. Quarantined at ${corruptPath}.`);
    } catch (quarantineError) {
      const quarantineReason = quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
      console.error(
        `[onboarding] Corrupt onboarding state recovered: ${reason}. Quarantine failed: ${quarantineReason}. Using default state.`,
      );
    }
  }
}
