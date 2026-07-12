import { NotImplementedError } from '../shared/errors';

export type AssemblerMode = 'chat' | 'heartbeat' | 'dream';

export interface ContextSection {
  layer: number;
  cacheStable: boolean;
  budget: number;
}

export interface ContextReport {
  sections: ContextSection[];
  totalTokens: number;
  truncated: boolean;
}

export class ContextAssembler {
  constructor() {
    throw new NotImplementedError('ContextAssembler');
  }

  async assemble(
    profileId: string,
    mode: AssemblerMode,
    recallResult: unknown,
  ): Promise<ContextReport> {
    void profileId;
    void mode;
    void recallResult;
    throw new NotImplementedError('ContextAssembler.assemble');
  }
}
