// src/tools/medical-tools.ts
import * as path from 'path';
import * as fs from 'fs';
import type { Tool, ToolResult } from './types';
import type { MemoryEngine } from '../memory/memory-engine';
import type { MemorySearch } from '../memory/search';
import type { LLMProvider, Message } from '../providers/types';

const MEDICAL_DISCLAIMER = '\n\n---\n*I am an AI health companion, not a doctor. Consult a healthcare professional for medical advice.*';

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
  reportContent: string,
  fileName: string
): Message[] {
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
5. End every response with the disclaimer`,
    },
    {
      role: 'user',
      content: `## Health Context\n${healthContext}\n\n## Report to Analyze\n**File:** ${fileName}\n\n**Content:**\n${reportContent}`,
    },
  ];
}

function resolveWorkspaceRelativePath(workspacePath: string, mediaPath: string): { fullPath: string } | { error: string } {
  if (path.isAbsolute(mediaPath)) {
    return { error: 'Error: mediaPath must be a workspace-relative path (for example: reports/lab.txt).' };
  }

  const workspaceRoot = path.resolve(workspacePath);
  const fullPath = path.resolve(workspaceRoot, mediaPath);
  const withinWorkspace = fullPath === workspaceRoot || fullPath.startsWith(workspaceRoot + path.sep);
  if (!withinWorkspace) {
    return { error: `Error: Invalid report path. Path traversal is not allowed: ${mediaPath}` };
  }

  return { fullPath };
}

function isSupportedTextReport(fullPath: string): boolean {
  const ext = path.extname(fullPath).toLowerCase();
  if (!ext) return true;
  return ['.txt', '.md', '.csv', '.json', '.log'].includes(ext);
}

function buildReportContextQuery(reportContent: string): string {
  return reportContent
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

export function createMedicalTools(
  memoryEngine: MemoryEngine,
  memorySearch: MemorySearch | undefined,
  medicalProvider: LLMProvider,
  mainProvider: LLMProvider,
  workspacePath: string
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
        // Graceful degradation: fall back to main LLM with warning
        console.warn('[medgemma_query] Medical provider failed, falling back to main LLM:', error);

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
          console.error('[medgemma_query] Main provider also failed:', fallbackError);
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
          description: 'Relative path to the report file within the workspace (e.g., "reports/blood-test-2024.pdf" or "lab-results.txt")',
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

      if (!isSupportedTextReport(fullPath)) {
        return {
          content: [{
            type: 'text',
            text: 'Error: Report analysis is text-only in Phase 2.6. Supported report files: .txt, .md, .csv, .json, .log.',
          }],
          isError: true,
        };
      }

      try {
        // Read the report content
        const reportContent = fs.readFileSync(fullPath, 'utf8');
        if (reportContent.includes('\u0000')) {
          return {
            content: [{
              type: 'text',
              text: 'Error: Report analysis is text-only in Phase 2.6 and this file appears to be binary.',
            }],
            isError: true,
          };
        }

        // Assemble health context
        const contextQuery = buildReportContextQuery(reportContent);
        const healthContext = await assembleHealthContext(memoryEngine, memorySearch, contextQuery);

        // Build prompt and call medical provider
        const messages = buildReportAnalysisPrompt(healthContext, reportContent, mediaPath);
        const response = await medicalProvider.chat(messages);

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
        // Graceful degradation: fall back to main LLM with warning
        console.warn('[medgemma_analyze_report] Medical provider failed, falling back to main LLM:', error);

        try {
          const reportContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
          const contextQuery = buildReportContextQuery(reportContent);
          const healthContext = await assembleHealthContext(memoryEngine, memorySearch, contextQuery);
          const fallbackMessages = buildReportAnalysisPrompt(healthContext, reportContent, mediaPath);
          const response = await mainProvider.chat(fallbackMessages);

          if (response.type === 'text') {
            return {
              content: [{ type: 'text', text: '⚠️ MedGemma unavailable. ' + response.text + MEDICAL_DISCLAIMER }],
            };
          }
        } catch (fallbackError) {
          console.error('[medgemma_analyze_report] Main provider also failed:', fallbackError);
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
