jest.mock('pdf-parse', () => {
  class PDFParse {
    static setWorker = jest.fn();
    private data: string;

    constructor(options: { data: Buffer | Uint8Array }) {
      this.data = Buffer.from(options.data).toString('utf8');
    }

    async getText(): Promise<{ text: string; total: number }> {
      if (this.data.includes('HbA1c 7.2 percent Fasting glucose 126 mg/dL')) {
        return { text: 'HbA1c 7.2 percent Fasting glucose 126 mg/dL\n\n-- 1 of 1 --\n\n', total: 1 };
      }
      return { text: '\n\n-- 1 of 1 --\n\n', total: 1 };
    }

    async getScreenshot(): Promise<{ pages: Array<{ data: Uint8Array; pageNumber: number }> }> {
      return { pages: [{ data: Uint8Array.from([137, 80, 78, 71]), pageNumber: 1 }] };
    }

    async destroy(): Promise<void> {}
  }

  return { PDFParse };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMedicalTools } from '../../src/tools/medical-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';
import type { MemorySearch } from '../../src/memory/search';
import type { LLMProvider, LLMResponse, TextResponse } from '../../src/providers/types';
import type { Tool } from '../../src/tools/types';

// Mock LLMProvider factory
function createMockProvider(responses: TextResponse[], options: { vision?: boolean } = {}): LLMProvider {
  let callCount = 0;
  const provider: LLMProvider = {
    chat: jest.fn(async (/* messages: Message[] */): Promise<LLMResponse> => {
      if (callCount < responses.length) {
        return responses[callCount++];
      }
      return { type: 'text', text: 'default response' };
    }),
    embed: jest.fn(async () => [0.1, 0.2, 0.3]),
  };
  if (options.vision) {
    provider.chatWithImages = jest.fn(async (): Promise<LLMResponse> => ({
      type: 'text',
      text: 'Vision medical response.',
    }));
  }
  return provider;
}

function createTextPdf(text: string): string {
  return `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${text.length + 36} >>
stream
BT
/F1 24 Tf
100 700 Td
(${text}) Tj
ET
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000311 00000 n 
trailer
<< /Root 1 0 R /Size 6 >>
startxref
435
%%EOF`;
}

function createBlankPdf(): string {
  return `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 0 >>
stream

endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000215 00000 n 
trailer
<< /Root 1 0 R /Size 5 >>
startxref
265
%%EOF`;
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
        tmpDir,
        { mainProviderType: 'ollama' }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_query')!;
      const result = await tool.execute({ question: 'What is my health status?' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Fallback response');
    });

    it('does not fall back to a non-local main provider for medical queries', async () => {
      const failingMedicalProvider: LLMProvider = {
        chat: jest.fn().mockRejectedValue(new Error('Medical provider unavailable')),
        embed: jest.fn().mockRejectedValue(new Error('Embedding failed')),
      };

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        failingMedicalProvider,
        mockMainProvider,
        tmpDir,
        { mainProviderType: 'openai' }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_query')!;
      const result = await tool.execute({ question: 'What is my health status?' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toContain('privacy');
      expect(mockMainProvider.chat).not.toHaveBeenCalled();
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
      const reportsDir = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      const reportPath = path.join(reportsDir, 'test-report.txt');
      fs.writeFileSync(reportPath, 'Blood Test Results: Normal range values observed.');

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/test-report.txt' });

      expect(result.isError).toBeFalsy();
      expect(mockMedicalProvider.chat).toHaveBeenCalled();
      // The medical provider should receive the report content
      const chatCalls = (mockMedicalProvider.chat as jest.Mock).mock.calls;
      expect(chatCalls.length).toBeGreaterThan(0);
    });

    it('rejects symlinked report paths that resolve outside workspace reports', async () => {
      const reportsDir = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      const outsidePath = path.join(tmpDir, '..', `outside-${Date.now()}.txt`);
      fs.writeFileSync(outsidePath, 'outside secret medical data');
      fs.symlinkSync(outsidePath, path.join(reportsDir, 'link.txt'));

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/link.txt' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Symlinks are not allowed');
      expect(mockMedicalProvider.chat).not.toHaveBeenCalled();

      fs.rmSync(outsidePath, { force: true });
    });

    it('extracts text from PDF reports and calls the medical provider with that text', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(
        path.join(reportPath, 'lab.pdf'),
        createTextPdf('HbA1c 7.2 percent Fasting glucose 126 mg/dL'),
        'utf8'
      );

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/lab.pdf' });

      expect(result.isError).toBeFalsy();
      expect(mockMedicalProvider.chat).toHaveBeenCalled();
      const messages = (mockMedicalProvider.chat as jest.Mock).mock.calls[0][0] as Array<{ content: string }>;
      expect(messages[1].content).toContain('HbA1c 7.2');
      expect(messages[1].content).toContain('PDF report');
    });

    it('sends PNG/JPEG reports as image attachments to the medical provider', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(
        path.join(reportPath, 'photo.jpg'),
        Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2w==', 'base64')
      );
      const visionMedicalProvider = createMockProvider([], { vision: true });

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        visionMedicalProvider,
        mockMainProvider,
        tmpDir,
        { medicalProviderType: 'ollama' }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/photo.jpg' });

      expect(result.isError).toBeFalsy();
      expect(visionMedicalProvider.chatWithImages).toHaveBeenCalled();
      const images = (visionMedicalProvider.chatWithImages as jest.Mock).mock.calls[0][1];
      expect(images[0]).toMatchObject({ mimeType: 'image/jpeg', filename: 'reports/photo.jpg' });
    });

    it('renders scanned PDFs to page images when no text can be extracted', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(path.join(reportPath, 'scan.pdf'), createBlankPdf(), 'utf8');
      const visionMedicalProvider = createMockProvider([], { vision: true });

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        visionMedicalProvider,
        mockMainProvider,
        tmpDir,
        { medicalProviderType: 'ollama' }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/scan.pdf' });

      expect(result.isError).toBeFalsy();
      expect(visionMedicalProvider.chatWithImages).toHaveBeenCalled();
      const images = (visionMedicalProvider.chatWithImages as jest.Mock).mock.calls[0][1];
      expect(images[0].mimeType).toBe('image/png');
      expect(images[0].filename).toContain('reports/scan.pdf#page-1.png');
    });

    it('does not send image reports to the fallback provider when medical vision fails', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(
        path.join(reportPath, 'photo.png'),
        Buffer.from('iVBORw0KGgo=', 'base64')
      );
      const failingVisionProvider: LLMProvider = {
        chat: jest.fn().mockRejectedValue(new Error('medical text failed')),
        chatWithImages: jest.fn().mockRejectedValue(new Error('fetch failed')),
        embed: jest.fn(async () => [0.1, 0.2, 0.3]),
      };

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        failingVisionProvider,
        mockMainProvider,
        tmpDir,
        { medicalProviderType: 'ollama' }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/photo.png' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('MedGemma vision analysis failed');
      expect(mockMainProvider.chat).not.toHaveBeenCalled();
    });

    it('does not echo a raw provider error message into the analyze-report result (F-2 PHI split)', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(path.join(reportPath, 'photo.png'), Buffer.from('iVBORw0KGgo=', 'base64'));
      const leakyVisionProvider: LLMProvider = {
        chat: jest.fn().mockRejectedValue(new Error('PROVIDER-PHI-LEAK glucose 300 chest pain')),
        chatWithImages: jest.fn().mockRejectedValue(new Error('PROVIDER-PHI-LEAK glucose 300 chest pain')),
        embed: jest.fn(async () => [0.1, 0.2, 0.3]),
      };
      const tools: Tool[] = createMedicalTools(
        engine, mockSearch, leakyVisionProvider, mockMainProvider, tmpDir, { medicalProviderType: 'ollama' },
      );
      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/photo.png' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('vision analysis failed'); // canned framing stays
      expect(result.content[0].text).not.toContain('PROVIDER-PHI-LEAK');
      expect(result.content[0].text).not.toContain('glucose 300');
    });

    it('blocks raw image reports for cloud medical providers unless explicitly opted in', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(
        path.join(reportPath, 'photo.jpg'),
        Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2w==', 'base64')
      );
      const cloudVisionProvider = createMockProvider([], { vision: true });

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        cloudVisionProvider,
        mockMainProvider,
        tmpDir,
        { medicalProviderType: 'openai' }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/photo.jpg' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('only enabled for local Ollama providers');
      expect(cloudVisionProvider.chatWithImages).not.toHaveBeenCalled();
      expect(mockMainProvider.chat).not.toHaveBeenCalled();
    });

    it('blocks raw image reports for remote Ollama medical providers unless explicitly opted in', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(
        path.join(reportPath, 'photo.jpg'),
        Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2w==', 'base64')
      );
      const remoteOllamaProvider = createMockProvider([], { vision: true });

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        remoteOllamaProvider,
        mockMainProvider,
        tmpDir,
        { medicalProviderType: 'ollama', medicalProviderBaseUrl: 'https://example-remote-ollama.invalid/v1' }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/photo.jpg' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('only enabled for local Ollama providers');
      expect(remoteOllamaProvider.chatWithImages).not.toHaveBeenCalled();
    });

    it('allows raw image reports for cloud medical providers when explicitly opted in', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(
        path.join(reportPath, 'photo.jpg'),
        Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2w==', 'base64')
      );
      const cloudVisionProvider = createMockProvider([], { vision: true });

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        cloudVisionProvider,
        mockMainProvider,
        tmpDir,
        { medicalProviderType: 'openai', allowRawMedicalMedia: true }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/photo.jpg' });

      expect(result.isError).toBeFalsy();
      expect(cloudVisionProvider.chatWithImages).toHaveBeenCalled();
    });

    it('rejects mislabeled image files before provider calls', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(path.join(reportPath, 'not-really.jpg'), '<html>not an image</html>');
      const visionMedicalProvider = createMockProvider([], { vision: true });

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        visionMedicalProvider,
        mockMainProvider,
        tmpDir,
        { medicalProviderType: 'ollama' }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/not-really.jpg' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not match');
      expect(visionMedicalProvider.chatWithImages).not.toHaveBeenCalled();
    });

    it('rejects binary content in text report files before provider calls', async () => {
      const reportPath = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportPath, { recursive: true });
      fs.writeFileSync(path.join(reportPath, 'binary.txt'), Buffer.from([0x48, 0x00, 0x49]));

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        mockMedicalProvider,
        mockMainProvider,
        tmpDir
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/binary.txt' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('appears to be binary');
      expect(mockMedicalProvider.chat).not.toHaveBeenCalled();
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

    it('does not fall back to a non-local main provider for text-derived report analysis', async () => {
      const reportsDir = path.join(tmpDir, 'reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(path.join(reportsDir, 'test-report.txt'), 'Blood Test Results: Normal range values observed.');
      const failingMedicalProvider: LLMProvider = {
        chat: jest.fn().mockRejectedValue(new Error('Medical provider unavailable')),
        embed: jest.fn(async () => [0.1, 0.2, 0.3]),
      };

      const tools: Tool[] = createMedicalTools(
        engine,
        mockSearch,
        failingMedicalProvider,
        mockMainProvider,
        tmpDir,
        { mainProviderType: 'openai' }
      );

      const tool = tools.find((t: Tool) => t.name === 'medgemma_analyze_report')!;
      const result = await tool.execute({ mediaPath: 'reports/test-report.txt' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'Error: Medical provider unavailable. Privacy guard blocked fallback to a non-local main provider. Retry after restoring the medical provider or configure a local main provider for fallback.',
      );
      expect(mockMainProvider.chat).not.toHaveBeenCalled();
    });
  });
});
