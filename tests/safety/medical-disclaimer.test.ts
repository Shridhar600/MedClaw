// tests/safety/medical-disclaimer.test.ts
// Regression: PROD-P2-8 — the medical disclaimer is now ONE exported constant.
// agent-loop and medical-tools must append the identical constant so a future
// wording change happens in exactly one place (medical-safety rule).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MEDICAL_DISCLAIMER, MEDICAL_DISCLAIMER_SENTINEL } from '../../src/safety/medical-disclaimer';
import { AgentLoop } from '../../src/agent/agent-loop';
import { ToolRegistry } from '../../src/tools/registry';
import { createMedicalTools } from '../../src/tools/medical-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';

describe('Unified MEDICAL_DISCLAIMER constant (PROD-P2-8)', () => {
  it('exports a non-empty disclaimer containing the AI-health-companion sentinel', () => {
    expect(typeof MEDICAL_DISCLAIMER).toBe('string');
    expect(MEDICAL_DISCLAIMER.length).toBeGreaterThan(0);
    expect(MEDICAL_DISCLAIMER).toContain(MEDICAL_DISCLAIMER_SENTINEL);
    expect(MEDICAL_DISCLAIMER_SENTINEL).toContain('I am an AI health companion, not a doctor');
  });

  it('medical tools append the exact exported constant', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-disclaimer-med-'));
    try {
      const engine = new MemoryEngine(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'HEALTH_PROFILE.md'), '# Profile\nnone');
      const medicalProvider: LLMProvider = {
        chat: jest.fn().mockResolvedValue({ type: 'text', text: 'Medical answer.' } as LLMResponse),
        embed: jest.fn().mockResolvedValue([0.1]),
      };
      const mainProvider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockResolvedValue([0.1]),
      };
      const tools = createMedicalTools(engine, undefined, medicalProvider, mainProvider, tmpDir);
      const query = tools.find((t) => t.name === 'medgemma_query')!;
      const result = await query.execute({ question: 'What about my blood sugar?' });
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toContain('Medical answer.');
      // The exact unified constant is appended — not a divergent local copy.
      expect((result.content[0] as { text: string }).text.endsWith(MEDICAL_DISCLAIMER)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('agent loop appends the exact exported constant for health responses', async () => {
    const provider: LLMProvider = {
      chat: jest.fn().mockResolvedValue({ type: 'text', text: 'Consider discussing this with a professional soon.' } as LLMResponse),
      embed: jest.fn().mockResolvedValue([]),
    };
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    const loop = new AgentLoop(
      provider,
      registry,
      async () => ({ messages: [], healthContextTouched: true }),
      { maxIterations: 15, disclaimerEnabled: true },
    );

    const result = await loop.run('My fasting glucose was 180 this morning.');
    expect(result.healthResponse).toBe(true);
    // The exact unified constant is appended — not a divergent local copy.
    expect(result.text.endsWith(MEDICAL_DISCLAIMER)).toBe(true);
    // The already-has-disclaimer sentinel keys off the SAME constant.
    expect(result.text.includes(MEDICAL_DISCLAIMER_SENTINEL)).toBe(true);
  });
});
