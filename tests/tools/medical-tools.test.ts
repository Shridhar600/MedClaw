import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMedicalTools } from '../../src/tools/medical-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';
import type { MemorySearch } from '../../src/memory/search';
import type { LLMProvider, LLMResponse, TextResponse } from '../../src/providers/types';
import type { Tool } from '../../src/tools/types';

// Mock LLMProvider factory
function createMockProvider(responses: TextResponse[]): LLMProvider {
  let callCount = 0;
  return {
    chat: jest.fn(async (/* messages: Message[] */): Promise<LLMResponse> => {
      if (callCount < responses.length) {
        return responses[callCount++];
      }
      return { type: 'text', text: 'default response' };
    }),
    embed: jest.fn(async () => [0.1, 0.2, 0.3]),
  };
}

describe('Medical Tools', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let mockMedicalProvider: LLMProvider;
  let mockMainProvider: LLMProvider;
  let mockSearch: MemorySearch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-medical-tools-'));
    engine = new MemoryEngine(tmpDir);

    // Set up workspace files for health context
    fs.mkdirSync(path.join(tmpDir, 'conditions'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'SOUL.md'),
      '# Soul\nI am health-conscious and exercise regularly.'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'HEALTH_PROFILE.md'),
      '# Health Profile\nAge: 30\nConditions: None'
    );

    mockMedicalProvider = createMockProvider([
      { type: 'text', text: 'Medical response: This is a medical answer.' },
    ]);

    mockMainProvider = createMockProvider([
      { type: 'text', text: 'Fallback response: This is a fallback answer.' },
    ]);

    mockSearch = {
      search: jest.fn().mockResolvedValue([
        { path: 'conditions/diabetes.md', content: 'Diabetes notes', score: 0.9 },
      ]),
    } as unknown as MemorySearch;
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  describe('medgemma_query', () => {
    it('assembles health context and queries medical provider', async () => {
      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_query')!;
      expect(tool).toBeDefined();

      const result = await tool.execute({ question: 'What about my blood sugar?' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Medical response');
      // Verify medical provider was called
      expect(mockMedicalProvider.chat).toHaveBeenCalled();
    });

    it('returns error when question is missing', async () => {
      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_query')!;
      const result = await tool.execute({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('question');
    });

    it('falls back to main LLM when medical provider fails', async () => {
      const failingMedicalProvider: LLMProvider = {
        chat: jest.fn().mockRejectedValue(new Error('Medical provider unavailable')),
        embed: jest.fn().mockRejectedValue(new Error('Embedding failed')),
      };

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        failingMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_query')!;
      const result = await tool.execute({ question: 'What is my health status?' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Fallback response');
    });
  });

  describe('medgemma_analyze_report', () => {
    it('validates that mediaPath is provided', async () => {
      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      expect(tool).toBeDefined();

      const result = await tool.execute({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('mediaPath');
    });

    it('returns error when file does not exist', async () => {
      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/nonexistent.txt' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('rejects workspace traversal paths', async () => {
      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: '../outside.txt' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toContain('path');
    });

    it('rejects absolute paths to enforce workspace-relative media contract', async () => {
      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: '/tmp/report.txt' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toContain('relative');
    });

    it('calls medical provider with report content', async () => {
      // Create a mock report file
      const reportPath = path.join(tmpDir, 'test-report.txt');
      fs.writeFileSync(reportPath, 'Blood Test Results: Normal range values observed.');

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'test-report.txt' });

      expect(result.isError).toBeFalsy();
      expect(mockMedicalProvider.chat).toHaveBeenCalled();
      // The medical provider should receive the report content
      const chatCalls = (mockMedicalProvider.chat as jest.Mock).mock.calls;
      expect(chatCalls.length).toBeGreaterThan(0);
    });

    it('rejects unsupported binary report formats explicitly in text-only mode', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(path.join(reportPath, 'scan.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]));

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/scan.pdf' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('text-only');
    });

    it('uses report content when building memory search context', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      const reportBody = 'Lab values: LDL 190 mg/dL, HDL 35 mg/dL, triglycerides elevated.';
      fs.writeFileSync(path.join(reportPath, 'lipid.txt'), reportBody, 'utf8');

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      await tool.execute({ mediaPath: 'reports/lipid.txt' });

      expect(mockSearch.search).toHaveBeenCalled();
      const queryUsedForSearch = (mockSearch.search as jest.Mock).mock.calls[0][0] as string;
      expect(queryUsedForSearch).toContain('LDL 190');
      expect(queryUsedForSearch).not.toContain('reports/lipid.txt');
    });
  });
});
