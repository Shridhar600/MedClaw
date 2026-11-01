import type { AgentRunResult, LLMProvider, Message, ToolSchema } from '../providers/types';
import type { ToolRegistry } from '../tools/registry';
import { LLMSemaphore, type SemaphorePriority } from '../tools/semaphore';
import { MEDICAL_DISCLAIMER, MEDICAL_DISCLAIMER_SENTINEL } from '../safety/medical-disclaimer';
import { parseUsedTag } from '../recall';
import type { AssemblerMode } from '../context2';
import { summarizeErrorForLog } from '../security';

const MEDICAL_TOOLS = new Set(['medgemma_query', 'medgemma_analyze_report']);

interface AgentConfig {
  maxIterations: number;
}

interface AgentRunContext {
  chatId?: string;
  turnId?: string;
  origin?: SemaphorePriority;
  /** The assembler mode for this turn (the Gateway owns the origin→mode mapping). */
  mode?: AssemblerMode;
}

/** The per-turn system prompt + an optional feedback sink for the <used> ids. */
export interface PreparedSystem {
  messages: Message[];
  recordUsed?: (usedIds: string[]) => Promise<void>;
  /** True when this turn received health data from SAFETY/profile/ledger/recall. */
  healthContextTouched?: boolean;
}

export type PrepareSystem = (mode: AssemblerMode, userMessage: string) => Promise<PreparedSystem>;

export class AgentLoop {
  private readonly prepareSystem: PrepareSystem;
  private turnSequence = 0;

  constructor(
    private readonly provider: LLMProvider,
    private readonly registry: ToolRegistry,
    systemSource: Message[] | PrepareSystem,
    private readonly config: AgentConfig,
    private readonly semaphore?: LLMSemaphore,
  ) {
    this.prepareSystem = typeof systemSource === 'function'
      ? systemSource
      : async () => ({ messages: systemSource });
  }

  async run(
    userMessage: string,
    conversationHistory: Message[] = [],
    runContext?: AgentRunContext,
  ): Promise<AgentRunResult> {
    const context: AgentRunContext = {
      ...runContext,
      turnId: runContext?.turnId ?? `${runContext?.chatId ?? 'anonymous'}:${++this.turnSequence}`,
    };
    const exec = (): Promise<AgentRunResult> => this.runInternal(userMessage, conversationHistory, context);
    if (this.semaphore) {
      const priority: SemaphorePriority = runContext?.origin ?? 'user';
      return this.semaphore.run(priority, exec, { chatId: runContext?.chatId, origin: priority });
    }
    return exec();
  }

  private async runInternal(
    userMessage: string,
    conversationHistory: Message[],
    runContext?: AgentRunContext,
  ): Promise<AgentRunResult> {
    const mode: AssemblerMode = runContext?.mode ?? 'chat';
    const prepared = await this.prepareSystem(mode, userMessage);
    const messages: Message[] = [
      ...prepared.messages,
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];
    const trace: Message[] = [];
    const usedTools: string[] = [];
    let lastPromptTokens: number | undefined;

    const tools: ToolSchema[] = this.registry.getAvailable(runContext?.origin).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));

    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      const response = await this.provider.chat(messages, tools);
      lastPromptTokens = response.usage?.promptTokens;

      if (response.type === 'text') {
        const { ids: usedIds, stripped: rawText } = parseUsedTag(response.text);
        if (usedIds.length > 0 && prepared.recordUsed) {
          try { await prepared.recordUsed(usedIds); } catch { /* recordUsage is best-effort + guarded */ }
        }
        const isHealthRelated = Boolean(
          prepared.healthContextTouched || usedTools.some((toolName) => MEDICAL_TOOLS.has(toolName)),
        );
        const alreadyHasDisclaimer = rawText.includes(MEDICAL_DISCLAIMER_SENTINEL);
        const finalText = isHealthRelated && !alreadyHasDisclaimer ? rawText + MEDICAL_DISCLAIMER : rawText;
        trace.push({ role: 'assistant', content: finalText });
        return {
          text: finalText,
          trace,
          usedTools: [...new Set(usedTools)],
          healthResponse: isHealthRelated,
          lastPromptTokens,
        };
      }

      const calls = response.toolCalls;
      for (const c of calls) usedTools.push(c.name);
      // Tool arguments routinely carry PHI: log names only, never the arguments.
      console.log(`[agent] Tool call: ${calls.map(c => c.name).join(', ')}`);

      const toolRequestMessage: Message = {
        role: 'assistant',
        content: null,
        tool_calls: calls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
      messages.push(toolRequestMessage);
      trace.push(toolRequestMessage);

      for (const c of calls) {
        let resultText: string;
        try {
          const toolResult = await this.registry.execute(c.name, c.arguments, { ...runContext, toolCallId: c.id });
          resultText = toolResult.content.map(r => r.text).join('\n');
        } catch (e) {
          console.warn('[agent] tool call failed:', summarizeErrorForLog(e));
          resultText = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
        }
        const toolResultMessage: Message = { role: 'tool', content: resultText, tool_call_id: c.id };
        messages.push(toolResultMessage);
        trace.push(toolResultMessage);
      }
    }

    const cappedText = `I reached the maximum number of reasoning steps (${this.config.maxIterations}). Please try rephrasing your request.`;
    trace.push({ role: 'assistant', content: cappedText });
    return {
      text: cappedText,
      trace,
      usedTools: [...new Set(usedTools)],
      healthResponse: false,
      lastPromptTokens,
    };
  }

}
