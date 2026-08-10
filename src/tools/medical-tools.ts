// src/tools/medical-tools.ts
import * as path from 'path';
import * as fs from 'fs';
import type { Tool, ToolResult } from './types';
import type { MemoryEngine } from '../memory/memory-engine';
import type { MemorySearch } from '../memory/search';
import type { LLMProvider, LLMResponse, Message } from '../providers/types';
import type { ProviderConfig } from '../config/types';
import { processReportFile, type ProcessedReport } from '../media/report-processor';
import { MEDICAL_DISCLAIMER } from '../safety/medical-disclaimer';
import { summarizeErrorForLog } from '../security';

/**
 * Assemble health context from memory for medical queries.
 * Reads HEALTH_PROFILE.md and searches for relevant health information.
 */
async function assembleHealthContext(
  memoryEngine: MemoryEngine,
  memorySearch: MemorySearch | undefined,
  query: string
): Promise<string> {
  const parts: string[] = [];

  // Read the user's health profile
  const healthProfile = await memoryEngine.readFile('HEALTH_PROFILE.md');
  if (healthProfile) {
    parts.push('## Health Profile\n' + healthProfile);
  }

  // Search for relevant health conditions and medications
  if (memorySearch) {
    try {
      const searchResults = await memorySearch.search(query, 5);
      if (searchResults.length > 0) {
        const relevantInfo = searchResults
          .map(r => `### ${r.path}\n${r.content}`)
          .join('\n\n');
        parts.push('## Relevant Health Information\n' + relevantInfo);
      }
    } catch (e) {
      // Graceful degradation - search is optional
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : 'No health profile on file.';
}

/**
 * Build the medical query prompt with context and safety framing.
 */
function buildMedicalQueryPrompt(
  healthContext: string,
  userQuestion: string
): Message[] {
  return [
    {
      role: 'system',
      content: `You are MedGemma, a medical AI assistant. Your role is to provide helpful, accurate health information while always being clear that you are not a medical professional.

CRITICAL SAFETY RULES:
- NEVER say "I diagnose you with" or "You have" — use "this may suggest", "consider discussing with your doctor"
- NEVER recommend stopping prescribed medication
- NEVER contradict a doctor's instructions
- When uncertain, say so explicitly
- Include the disclaimer at the end of every response

When responding:
1. Acknowledge what you understand about their question
2. Provide relevant health information based on the context
3. Suggest consulting a healthcare professional when appropriate
4. Always end with the disclaimer`,
    },
    {
      role: 'user',
      content: `## Health Context\n${healthContext}\n\n## User Question\n${userQuestion}`,
    },
  ];
}

/**
 * Build the report analysis prompt with context and safety framing.
 */
function buildReportAnalysisPrompt(
  healthContext: string,
  report: ProcessedReport,
  fileName: string
): Message[] {
  const reportPayload = report.textContent
    ? `**Extracted Content:**\n${report.textContent}`
    : '**Attached Images:** Analyze the attached image(s) as the source medical report. Extract visible values and state uncertainty when text is unreadable.';

  return [
    {
      role: 'system',
      content: `You are MedGemma, a medical AI assistant. Your role is to help interpret medical reports and test results while always being clear that you are not a medical professional.

CRITICAL SAFETY RULES:
- NEVER say "I diagnose you with" or "You have" — use "this may suggest", "consider discussing with your doctor"
- NEVER recommend stopping prescribed medication
- NEVER contradict a doctor's instructions
- When uncertain, say so explicitly
- Include the disclaimer at the end of every response

When interpreting reports:
1. Summarize what the report shows in plain language
2. Highlight any values that appear outside normal ranges
3. Explain what different results might mean in context of their health profile
4. Always suggest discussing with a healthcare provider for proper interpretation
5. For lab reports, extract visible test names, values, units, reference ranges, and abnormal flags
6. State image/PDF quality limitations and uncertainty explicitly
7. End every response with the disclaimer`,
    },
    {
      role: 'user',
      content: `## Health Context\n${healthContext}\n\n## Report to Analyze\n**File:** ${fileName}\n**Input:** ${report.metadata}\n\n${reportPayload}`,
    },
  ];
}

function resolveWorkspaceRelativePath(workspacePath: string, mediaPath: string): { fullPath: string } | { error: string } {
  if (path.isAbsolute(mediaPath)) {
    return { error: 'Error: mediaPath must be a workspace-relative path (for example: reports/lab.txt).' };
  }

  const normalizedMediaPath = mediaPath.replace(/\\/g, '/');
  if (normalizedMediaPath !== 'reports' && !normalizedMediaPath.startsWith('reports/')) {
    return { error: 'Error: mediaPath must point to a file under workspace/reports/.' };
  }

  const workspaceRoot = path.resolve(workspacePath);
  const reportsRoot = path.join(workspaceRoot, 'reports');
  const fullPath = path.resolve(workspaceRoot, mediaPath);
  const withinReports = fullPath === reportsRoot || fullPath.startsWith(reportsRoot + path.sep);
  if (!withinReports) {
    return { error: `Error: Invalid report path. Path traversal is not allowed: ${mediaPath}` };
  }

  if (fs.existsSync(fullPath)) {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      return { error: `Error: Invalid report path. Symlinks are not allowed: ${mediaPath}` };
    }
    const reportsRealPath = fs.realpathSync(reportsRoot);
    const fileRealPath = fs.realpathSync(fullPath);
    const realPathWithinReports = fileRealPath === reportsRealPath || fileRealPath.startsWith(reportsRealPath + path.sep);
    if (!realPathWithinReports) {
      return { error: `Error: Invalid report path. Real path escapes workspace/reports/: ${mediaPath}` };
    }
  }

  return { fullPath };
}

export interface MedicalToolsOptions {
  medicalProviderType?: ProviderConfig['type'];
  medicalProviderBaseUrl?: string;
  allowRawMedicalMedia?: boolean;
  mainProviderType?: ProviderConfig['type'];
  mainProviderBaseUrl?: string;
}

export function createMedicalTools(
  memoryEngine: MemoryEngine,
  memorySearch: MemorySearch | undefined,
  medicalProvider: LLMProvider,
  mainProvider: LLMProvider,
  workspacePath: string,
  options: MedicalToolsOptions = {},
): Tool[] {
  const medgemmaQuery: Tool = {
    name: 'medgemma_query',
    group: 'group:medical',
    description:
      'Query MedGemma for medical health information. Use this when you have health-related questions about symptoms, conditions, medications, or general wellness. Assembles the user\'s health profile and relevant medical history to provide context-aware responses. Always encourages consulting a healthcare professional.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The health question to ask MedGemma (e.g., "What are the symptoms of dehydration?", "Is it safe to take ibuprofen with my current medications?")',
        },
      },
      required: ['question'],
    },
    async execute(params): Promise<ToolResult> {
      const question = params.question as string;

      if (!question || typeof question !== 'string' || question.trim() === '') {
        return {
          content: [{ type: 'text', text: 'Error: question parameter is required and must be a non-empty string.' }],
          isError: true,
        };
      }

      try {
        // Assemble health context from memory
        const healthContext = await assembleHealthContext(memoryEngine, memorySearch, question);

        // Build prompt and call medical provider
        const messages = buildMedicalQueryPrompt(healthContext, question);
        const response = await medicalProvider.chat(messages);

        if (response.type === 'text') {
          return {
            content: [{ type: 'text', text: response.text + MEDICAL_DISCLAIMER }],
          };
        }

        // Handle unexpected response type
        return {
          content: [{ type: 'text', text: 'Unexpected response format from medical provider.' }],
          isError: true,
        };
      } catch (error) {
        if (!canFallbackMedicalTextToMain(options)) {
          return {
            content: [{
              type: 'text',
              text: 'Error: Medical provider unavailable. Privacy guard blocked fallback to a non-local main provider. Retry after restoring the medical provider or configure a local main provider for fallback.',
            }],
            isError: true,
          };
        }

        // Graceful degradation only when the fallback provider is local.
        // Provider error messages can echo user health context (PHI) — log the
        // sanitized frame only, never the raw error.
        console.warn('[medgemma_query] Medical provider failed, falling back to local main LLM:', summarizeErrorForLog(error));

        try {
          const healthContext = await assembleHealthContext(memoryEngine, memorySearch, question);
          const fallbackMessages = buildMedicalQueryPrompt(healthContext, question);
          const response = await mainProvider.chat(fallbackMessages);

          if (response.type === 'text') {
            return {
              content: [{ type: 'text', text: '⚠️ MedGemma unavailable. ' + response.text + MEDICAL_DISCLAIMER }],
            };
          }
        } catch (fallbackError) {
          console.error('[medgemma_query] Main provider also failed:', summarizeErrorForLog(fallbackError));
        }

        return {
          content: [{ type: 'text', text: 'Error: Both medical and fallback providers failed. Please try again later.' }],
          isError: true,
        };
      }
    },
  };

  const medgemmaAnalyzeReport: Tool = {
    name: 'medgemma_analyze_report',
    group: 'group:medical',
    description:
      'Analyze a medical report or test results file. Reads the report content, combines it with the user\'s health profile and relevant medical history, and provides an interpretation of the results. Use for blood tests, imaging reports, lab results, or other medical documents. Always recommends consulting a healthcare professional for proper diagnosis.',
    parameters: {
      type: 'object',
      properties: {
        mediaPath: {
          type: 'string',
          description: 'Relative path to the report file under workspace/reports (e.g., "reports/blood-test-2024.pdf" or "reports/lab-results.txt")',
        },
      },
      required: ['mediaPath'],
    },
    async execute(params): Promise<ToolResult> {
      const mediaPath = params.mediaPath as string;

      if (!mediaPath || typeof mediaPath !== 'string' || mediaPath.trim() === '') {
        return {
          content: [{ type: 'text', text: 'Error: mediaPath parameter is required and must be a non-empty string.' }],
          isError: true,
        };
      }

      const resolved = resolveWorkspaceRelativePath(workspacePath, mediaPath);
      if ('error' in resolved) {
        return {
          content: [{ type: 'text', text: resolved.error }],
          isError: true,
        };
      }
      const { fullPath } = resolved;

      if (!fs.existsSync(fullPath)) {
        return {
          content: [{ type: 'text', text: `Error: Report file not found: ${mediaPath}` }],
          isError: true,
        };
      }

      let report: ProcessedReport | undefined;
      try {
        report = await processReportFile(fullPath, mediaPath);

        // Assemble health context
        const healthContext = await assembleHealthContext(memoryEngine, memorySearch, report.contextQuery);

        // Build prompt and call medical provider
        const messages = buildReportAnalysisPrompt(healthContext, report, mediaPath);
        const response = report.images?.length
          ? await callMedicalVisionProvider(medicalProvider, messages, report, options)
          : await medicalProvider.chat(messages);

        if (response.type === 'text') {
          return {
            content: [{ type: 'text', text: response.text + MEDICAL_DISCLAIMER }],
          };
        }

        return {
          content: [{ type: 'text', text: 'Unexpected response format from medical provider.' }],
          isError: true,
        };
      } catch (error) {
        if (!report || report.images?.length || isImageOnlyFailure(error)) {
          return {
            content: [{
              type: 'text',
              text: buildReportErrorMessage(error, report),
            }],
            isError: true,
          };
        }

        if (!canFallbackMedicalTextToMain(options)) {
          return {
            content: [{
              type: 'text',
              text: 'Error: Medical provider unavailable. Privacy guard blocked fallback to a non-local main provider. Retry after restoring the medical provider or configure a local main provider for fallback.',
            }],
            isError: true,
          };
        }

        // Graceful degradation only when the fallback provider is local.
        // Provider error messages can echo user health context (PHI) — log the
        // sanitized frame only, never the raw error.
        console.warn('[medgemma_analyze_report] Medical provider failed, falling back to local main LLM:', summarizeErrorForLog(error));

        try {
          const healthContext = await assembleHealthContext(memoryEngine, memorySearch, report.contextQuery);
          const fallbackMessages = buildReportAnalysisPrompt(healthContext, report, mediaPath);
          const response = await mainProvider.chat(fallbackMessages);

          if (response.type === 'text') {
            return {
              content: [{ type: 'text', text: '⚠️ MedGemma unavailable. ' + response.text + MEDICAL_DISCLAIMER }],
            };
          }
        } catch (fallbackError) {
          console.error('[medgemma_analyze_report] Main provider also failed:', summarizeErrorForLog(fallbackError));
        }

        return {
          content: [{ type: 'text', text: 'Error: Both medical and fallback providers failed. Please try again later.' }],
          isError: true,
        };
      }
    },
  };

  return [medgemmaQuery, medgemmaAnalyzeReport];
}

async function callMedicalVisionProvider(
  provider: LLMProvider,
  messages: Message[],
  report: ProcessedReport,
  options: MedicalToolsOptions,
): Promise<LLMResponse> {
  if (!canSendRawMedicalMedia(options)) {
    throw new Error('Raw medical image/PDF page analysis is only enabled for local Ollama providers unless allowRawMedicalMedia is explicitly true.');
  }
  if (!provider.chatWithImages) {
    throw new Error('The configured medical provider does not support image input.');
  }
  return provider.chatWithImages(messages, report.images ?? []);
}

function canSendRawMedicalMedia(options: MedicalToolsOptions): boolean {
  return options.allowRawMedicalMedia === true || isLocalOllamaProvider(options.medicalProviderType, options.medicalProviderBaseUrl);
}

function canFallbackMedicalTextToMain(options: MedicalToolsOptions): boolean {
  return isLocalProvider(options.mainProviderType, options.mainProviderBaseUrl);
}

function isLocalOllamaProvider(
  providerType: ProviderConfig['type'] | undefined,
  baseUrl: string | undefined,
): boolean {
  return providerType === 'ollama' && isLocalProvider(providerType, baseUrl);
}

function isLocalProvider(
  providerType: ProviderConfig['type'] | undefined,
  baseUrl: string | undefined,
): boolean {
  if (!providerType) {
    return false;
  }
  if (!baseUrl) {
    return providerType === 'ollama';
  }

  try {
    const parsed = new URL(baseUrl);
    return isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0.0.0.0';
}

function isImageOnlyFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('vision')
    || error.message.includes('image input')
    || error.message.includes('no pages could be rendered');
}

function buildReportErrorMessage(error: unknown, report: ProcessedReport | undefined): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (!report) {
    return `Error: Report processing failed. ${detail}`;
  }
  return `Error: MedGemma vision analysis failed. ${detail} Please ensure the configured medical provider is a local vision-capable model and try again.`;
}
