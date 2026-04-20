import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { PDFParse } from 'pdf-parse';
import type { ImageAttachment } from '../providers/types';

const workerGlobal = globalThis as unknown as { Worker?: typeof Worker };
workerGlobal.Worker ??= Worker;
PDFParse.setWorker(path.join(path.dirname(require.resolve('pdf-parse')), 'pdf.worker.mjs'));

export type ProcessedReportKind = 'text' | 'pdf-text' | 'image' | 'pdf-image';

export interface ProcessedReport {
  kind: ProcessedReportKind;
  metadata: string;
  textContent?: string;
  images?: ImageAttachment[];
  contextQuery: string;
}

export interface ReportProcessingOptions {
  maxTextChars?: number;
  maxTextBytes?: number;
  maxImageBytes?: number;
  maxPdfBytes?: number;
  maxPdfPages?: number;
  pdfRenderWidth?: number;
}

const DEFAULT_MAX_TEXT_CHARS = 30000;
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_PDF_PAGES = 3;
const DEFAULT_PDF_RENDER_WIDTH = 1024;

const TEXT_EXTENSIONS = new Set(['', '.txt', '.md', '.csv', '.json', '.log']);
const IMAGE_MIME_BY_EXTENSION = new Map<string, ImageAttachment['mimeType']>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

export async function processReportFile(
  fullPath: string,
  mediaPath: string,
  options: ReportProcessingOptions = {},
): Promise<ProcessedReport> {
  const ext = path.extname(fullPath).toLowerCase();
  const stats = fs.statSync(fullPath);

  if (TEXT_EXTENSIONS.has(ext)) {
    enforceSize(stats.size, options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES, 'Text report');
    return processTextReport(fullPath, mediaPath, options);
  }

  if (ext === '.pdf') {
    enforceSize(stats.size, options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES, 'PDF report');
    return processPdfReport(fullPath, mediaPath, options);
  }

  const imageMime = IMAGE_MIME_BY_EXTENSION.get(ext);
  if (imageMime) {
    enforceSize(stats.size, options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES, 'Image report');
    return {
      kind: 'image',
      metadata: `Image report: ${mediaPath} (${imageMime}, ${formatBytes(stats.size)})`,
      images: [readImageAttachment(fullPath, mediaPath, imageMime)],
      contextQuery: buildFilenameContext(mediaPath, 'uploaded medical image report'),
    };
  }

  throw new Error('Unsupported report file type. Supported files: .txt, .md, .csv, .json, .log, .pdf, .png, .jpg, .jpeg.');
}

function processTextReport(
  fullPath: string,
  mediaPath: string,
  options: ReportProcessingOptions,
): ProcessedReport {
  const raw = fs.readFileSync(fullPath, 'utf8');
  if (raw.includes('\u0000')) {
    throw new Error('This file appears to be binary. Supported binary report files: .pdf, .png, .jpg, .jpeg.');
  }

  const textContent = truncateText(raw, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
  return {
    kind: 'text',
    metadata: `Text report: ${mediaPath}`,
    textContent,
    contextQuery: buildReportContextQuery(textContent),
  };
}

async function processPdfReport(
  fullPath: string,
  mediaPath: string,
  options: ReportProcessingOptions,
): Promise<ProcessedReport> {
  const maxPdfPages = options.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES;
  const pdfData = fs.readFileSync(fullPath);
  if (!pdfData.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('File has a .pdf extension but does not look like a PDF document.');
  }

  const parser = new PDFParse({ data: pdfData });
  try {
    const textResult = await parser.getText({ first: maxPdfPages });
    const extractedText = stripPdfPageMarkers(textResult.text).trim();
    if (extractedText.length > 0) {
      const textContent = truncateText(extractedText, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
      return {
        kind: 'pdf-text',
        metadata: `PDF report: ${mediaPath}; extracted text from first ${Math.min(maxPdfPages, textResult.total)} page(s).`,
        textContent,
        contextQuery: buildReportContextQuery(textContent),
      };
    }

    const screenshots = await parser.getScreenshot({
      first: maxPdfPages,
      desiredWidth: options.pdfRenderWidth ?? DEFAULT_PDF_RENDER_WIDTH,
      imageBuffer: true,
      imageDataUrl: false,
    });
    const images = screenshots.pages
      .filter((page) => page.data.length > 0)
      .map((page) => ({
        mimeType: 'image/png' as const,
        data: Buffer.from(page.data).toString('base64'),
        filename: `${mediaPath}#page-${page.pageNumber}.png`,
      }));

    if (images.length === 0) {
      throw new Error('PDF text extraction found no readable text and no pages could be rendered for vision analysis.');
    }

    return {
      kind: 'pdf-image',
      metadata: `Scanned/image PDF report: ${mediaPath}; rendered ${images.length} page image(s) for analysis.`,
      images,
      contextQuery: buildFilenameContext(mediaPath, 'uploaded scanned medical PDF report'),
    };
  } finally {
    await parser.destroy();
  }
}

function readImageAttachment(
  fullPath: string,
  mediaPath: string,
  mimeType: ImageAttachment['mimeType'],
): ImageAttachment {
  const data = fs.readFileSync(fullPath);
  validateImageSignature(data, mimeType);
  return {
    mimeType,
    data: data.toString('base64'),
    filename: mediaPath,
  };
}

function validateImageSignature(data: Buffer, mimeType: ImageAttachment['mimeType']): void {
  const isPng = data.length >= 8
    && data[0] === 0x89
    && data[1] === 0x50
    && data[2] === 0x4e
    && data[3] === 0x47
    && data[4] === 0x0d
    && data[5] === 0x0a
    && data[6] === 0x1a
    && data[7] === 0x0a;
  const isJpeg = data.length >= 3
    && data[0] === 0xff
    && data[1] === 0xd8
    && data[2] === 0xff;

  if ((mimeType === 'image/png' && !isPng) || (mimeType === 'image/jpeg' && !isJpeg)) {
    throw new Error(`File extension does not match a valid ${mimeType} image.`);
  }
}

function stripPdfPageMarkers(text: string): string {
  return text.replace(/\n-- \d+ of \d+ --\n/g, '\n').trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[TRUNCATED REPORT: ${text.length - maxChars} chars omitted]`;
}

function buildReportContextQuery(reportContent: string): string {
  return reportContent
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function buildFilenameContext(mediaPath: string, label: string): string {
  const fileName = path.basename(mediaPath).replace(/[-_]/g, ' ');
  return `${label}: ${fileName}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function enforceSize(size: number, maxSize: number, label: string): void {
  if (size > maxSize) {
    throw new Error(`${label} is too large: ${formatBytes(size)}. Limit is ${formatBytes(maxSize)}.`);
  }
}
