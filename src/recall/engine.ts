import { NotImplementedError } from '../shared/errors';
import type { EmbeddingPort } from '../ports/embedding-port';
import type { VectorIndex } from '../ports/vector-index';
import type { KeywordIndex } from '../ports/keyword-index';
import type { FactMirror } from '../ports/fact-mirror';

export interface RecallConfig {
  topKNarrative: number;
  topKKeyword: number;
  narrativeBudget: number;
  halfLifeDays: number;
  scoreThreshold: number;
  safetyThreshold: number;
}

export interface RecallInput {
  profileId: string;
  userMessage: string;
}

export interface RecallStageResult {
  safety: string;
  ledger: string;
  narrative: string;
  entity: string;
}

export class RecallEngine {
  constructor(
    private embedding: EmbeddingPort,
    private vectorIndex: VectorIndex,
    private keywordIndex: KeywordIndex,
    private factMirror: FactMirror,
    private config: RecallConfig,
  ) {
    throw new NotImplementedError('RecallEngine');
  }

  async run(input: RecallInput): Promise<RecallStageResult> {
    void input;
    throw new NotImplementedError('RecallEngine.run');
  }

  private async stage1Ledger(): Promise<string> {
    throw new NotImplementedError('stage1Ledger');
  }

  private async stage2Narrative(input: RecallInput): Promise<string> {
    void input;
    throw new NotImplementedError('stage2Narrative');
  }

  private async stage3Entity(input: RecallInput): Promise<string> {
    void input;
    throw new NotImplementedError('stage3Entity');
  }
}
