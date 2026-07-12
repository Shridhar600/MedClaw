import type { AgentRunResult, LLMProvider, Message, ToolSchema } from '../providers/types';
import type { ToolRegistry } from '../tools/registry';
import { LLMSemaphore, type SemaphorePriority } from '../tools/semaphore';

const MEDICAL_DISCLAIMER = '\n\n---\n*I am an AI health companion, not a doctor. Always consult a healthcare professional for medical advice.*';
const MEDICAL_TOOLS = new Set(['medgemma_query', 'medgemma_analyze_report']);

interface AgentConfig {
  maxIterations: number;
  disclaimerEnabled: boolean;
}

interface AgentRunContext {
  chatId?: string;
  origin?: SemaphorePriority;
}

export class AgentLoop {
  constructor(
    private readonly provider: LLMProvider,
    private readonly registry: ToolRegistry,
    private readonly systemMessages: Message[],
    private readonly config: AgentConfig,
    private readonly semaphore?: LLMSemaphore,
  ) {}

  async run(
    userMessage: string,
    conversationHistory: Message[] = [],
    runContext?: AgentRunContext,
  ): Promise<AgentRunResult> {
    const exec = (): Promise<AgentRunResult> => this.runInternal(userMessage, conversationHistory, runContext);
    if (this.semaphore) {
      const priority: SemaphorePriority = runContext?.origin ?? 'user';
      return this.semaphore.run(priority, exec);
    }
    return exec();
  }

  private async runInternal(
    userMessage: string,
    conversationHistory: Message[],
    runContext?: AgentRunContext,
  ): Promise<AgentRunResult> {
    const messages: Message[] = [
      ...this.systemMessages,
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];
    const trace: Message[] = [];
    const usedTools: string[] = [];

    const tools: ToolSchema[] = this.registry.getAvailable().map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));

    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      const response = await this.provider.chat(messages, tools);

      if (response.type === 'text') {
        const rawText = response.text;
        const isHealthRelated = this.config.disclaimerEnabled
          && this.isHealthResponse(userMessage, rawText, usedTools);
        const alreadyHasDisclaimer = rawText.includes('I am an AI health companion, not a doctor');
        const finalText = isHealthRelated && !alreadyHasDisclaimer ? rawText + MEDICAL_DISCLAIMER : rawText;
        trace.push({ role: 'assistant', content: finalText });
        return {
          text: finalText,
          trace,
          usedTools: [...new Set(usedTools)],
          healthResponse: isHealthRelated,
        };
      }

      // Tool call
      const { id, name, arguments: args } = response.toolCall;
      usedTools.push(name);
      console.log(`[agent] Tool call: ${name}(${JSON.stringify(args)})`);

      // Append assistant's tool request to messages
      const toolRequestMessage: Message = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      };
      messages.push(toolRequestMessage);
      trace.push(toolRequestMessage);

      // Execute tool
      const toolResult = await this.registry.execute(name, args, runContext);
      const resultText = toolResult.content.map(c => c.text).join('\n');

      // Append tool result
      const toolResultMessage: Message = { role: 'tool', content: resultText, tool_call_id: id };
      messages.push(toolResultMessage);
      trace.push(toolResultMessage);
    }

    const cappedText = `I reached the maximum number of reasoning steps (${this.config.maxIterations}). Please try rephrasing your request.`;
    trace.push({ role: 'assistant', content: cappedText });
    return {
      text: cappedText,
      trace,
      usedTools: [...new Set(usedTools)],
      healthResponse: false,
    };
  }

  private looksHealthRelated(text: string): boolean {
    const keywords = [
      'health', 'medical', 'symptom', 'medication', 'blood', 'glucose', 'fasting', 'diabetes',
      'pain', 'doctor', 'diagnosis', 'hba1c', 'cholesterol', 'bp',
    ];
    const lower = text.toLowerCase();
    return keywords.some(k => lower.includes(k));
  }

  private isHealthResponse(userMessage: string, responseText: string, usedTools: string[]): boolean {
    if (usedTools.some((toolName) => MEDICAL_TOOLS.has(toolName))) {
      return true;
    }
    if (this.looksHealthRelated(userMessage)) {
      return true;
    }
    return this.looksHealthRelated(responseText);
  }
}
