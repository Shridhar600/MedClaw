import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMedicalTools } from '../src/tools/medical-tools';
import { MemoryEngine } from '../src/memory/memory-engine';
import type { ImageAttachment, LLMProvider, LLMResponse, Message } from '../src/providers/types';

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

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-medical-media-smoke-'));
  fs.mkdirSync(path.join(tmpDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'HEALTH_PROFILE.md'), '# Health Profile\nAge: 30\n');
  fs.writeFileSync(
    path.join(tmpDir, 'reports/lab.pdf'),
    createTextPdf('HbA1c 7.2 percent Fasting glucose 126 mg/dL'),
  );
  fs.writeFileSync(path.join(tmpDir, 'reports/scan.pdf'), createBlankPdf());
  fs.writeFileSync(
    path.join(tmpDir, 'reports/photo.jpg'),
    Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2w==', 'base64'),
  );
  const textReports = [
    ['plain.txt', 'Plain text marker HbA1c 6.9'],
    ['notes.md', '# Markdown report\nLDL marker 190'],
    ['table.csv', 'test,value\nHDL,35'],
    ['data.json', '{"marker":"glucose","value":126}'],
    ['events.log', 'LOG_MARKER triglycerides elevated'],
  ] as const;
  for (const [fileName, content] of textReports) {
    fs.writeFileSync(path.join(tmpDir, 'reports', fileName), content);
  }
  fs.writeFileSync(path.join(tmpDir, 'reports/binary.txt'), Buffer.from([0x48, 0x00, 0x49]));

  let lastTextPrompt = '';
  let lastVisionPrompt = '';
  let lastImages: ImageAttachment[] = [];
  const textPrompts: string[] = [];
  const provider: LLMProvider = {
    chat: async (messages: Message[]): Promise<LLMResponse> => {
      lastTextPrompt = messages.map((message) => message.content ?? '').join('\n');
      textPrompts.push(lastTextPrompt);
      return { type: 'text', text: 'text-report-analysis' };
    },
    chatWithImages: async (messages: Message[], images: ImageAttachment[]): Promise<LLMResponse> => {
      lastVisionPrompt = messages.map((message) => message.content ?? '').join('\n');
      lastImages = images;
      return { type: 'text', text: 'vision-report-analysis' };
    },
    embed: async () => [0.1, 0.2, 0.3],
  };

  const tools = createMedicalTools(
    new MemoryEngine(tmpDir),
    { search: async () => [] } as never,
    provider,
    provider,
    tmpDir,
    { medicalProviderType: 'ollama' },
  );
  const tool = tools.find((candidate) => candidate.name === 'medgemma_analyze_report');
  if (!tool) throw new Error('medgemma_analyze_report missing');

  const pdfText = await tool.execute({ mediaPath: 'reports/lab.pdf' });
  const pdfTextPrompt = lastTextPrompt;
  const scannedPdf = await tool.execute({ mediaPath: 'reports/scan.pdf' });
  const scannedPdfImages = lastImages;
  const scannedPdfPng = Buffer.from(scannedPdfImages[0]?.data ?? '', 'base64');
  const image = await tool.execute({ mediaPath: 'reports/photo.jpg' });
  const directImageImages = lastImages;
  const textResults = await Promise.all(
    textReports.map(([fileName]) => tool.execute({ mediaPath: `reports/${fileName}` })),
  );
  const binaryText = await tool.execute({ mediaPath: 'reports/binary.txt' });

  console.log(`SMOKE_DIR=${tmpDir}`);
  console.log(`PDF_TEXT_OK=${!pdfText.isError && pdfTextPrompt.includes('HbA1c 7.2')}`);
  console.log(`SCANNED_PDF_IMAGE_OK=${!scannedPdf.isError && scannedPdfImages[0]?.filename?.includes('reports/scan.pdf#page-1.png')}`);
  console.log(`SCANNED_PDF_PNG_SIGNATURE_OK=${scannedPdfPng[0] === 0x89 && scannedPdfPng[1] === 0x50 && scannedPdfPng[2] === 0x4e && scannedPdfPng[3] === 0x47}`);
  console.log(`IMAGE_OK=${!image.isError && directImageImages[0]?.filename === 'reports/photo.jpg'}`);
  console.log(`TEXT_FORMATS_OK=${textResults.every((result) => !result.isError) && textPrompts.some((prompt) => prompt.includes('Plain text marker')) && textPrompts.some((prompt) => prompt.includes('LDL marker')) && textPrompts.some((prompt) => prompt.includes('HDL,35')) && textPrompts.some((prompt) => prompt.includes('"marker":"glucose"')) && textPrompts.some((prompt) => prompt.includes('LOG_MARKER'))}`);
  console.log(`BINARY_TEXT_REJECTED=${binaryText.isError && binaryText.content[0]?.text.includes('appears to be binary')}`);
  console.log(`VISION_PROMPT_HAS_SAFETY=${lastVisionPrompt.includes('CRITICAL SAFETY RULES')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
