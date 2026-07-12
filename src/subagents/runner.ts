import { NotImplementedError } from '../shared/errors';
import type { IdGen } from '../ports/id-gen';

export interface SubagentSpec {
  kind: string;
  task: string;
  providerSlot: 'main' | 'medical' | 'worker';
  tools: string[];
  contextFiles: string[];
  maxIterations: number;
  timeoutMs: number;
}

export interface SubagentResult {
  runId: string;
  kind: string;
  status: 'ok' | 'error' | 'timeout';
  text: string;
  toolTrace: string[];
  verifyHint: string;
}

export class SubagentRunner {
  constructor(
    private idGen: IdGen,
  ) {
    throw new NotImplementedError('SubagentRunner');
  }

  async spawn(profileId: string, spec: SubagentSpec): Promise<{ runId: string }> {
    void profileId;
    void spec;
    throw new NotImplementedError('SubagentRunner.spawn');
  }

  async collect(runId: string): Promise<SubagentResult> {
    void runId;
    throw new NotImplementedError('SubagentRunner.collect');
  }
}
