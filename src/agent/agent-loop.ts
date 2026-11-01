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
  disclaimerEnabled: boolean;
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

/**
 * Builds the system prompt fresh for a turn. Recall + assembly happen inside; SAFETY is re-rendered every turn.
 * A thrown InvariantViolationError aborts the turn (medical-safety).
 */
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
    // A static Message[] becomes a constant supplier; a function is used per turn (per-turn assembly, not a
    // boot-cached system prompt).
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
    // Per-turn system assembly: SAFETY + recall are rebuilt for this turn. A SAFETY-invariant violation here throws
    // and aborts this turn (medical-safety > resilience); the Gateway's outer handler turns it into a safe fallback
    // reply, so the daemon never crashes.
    const mode: AssemblerMode = runContext?.mode ?? 'chat';
    const prepared = await this.prepareSystem(mode, userMessage);
    const messages: Message[] = [
      ...prepared.messages,
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];
    const trace: Message[] = [];
    const usedTools: string[] = [];
    // The last provider call's promptTokens is the window-fill signal. Overwritten each call so the final call
    // (full accumulated context) is the value surfaced on the result.
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
      // The last provider call's reading wins: assign every iteration (undefined included). If the final call omits
      // usage, surface `undefined` (chars/4 estimate downstream), not a stale earlier count that under-reports the
      // largest (final) prompt and skips a trigger.
      lastPromptTokens = response.usage?.promptTokens;

      if (response.type === 'text') {
        // The <used> tag is parsed + stripped before health-classification / disclaimer / persist / send; a
        // missing or garbled tag is simply no signal, never an error.
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

      // Tool calls — execute all the model requested this turn; never drop the tail. OpenAI strict ordering: one
      // assistant message carrying every tool_call, then one `tool` result per call (in request order). Executed
      // sequentially.
      const calls = response.toolCalls;
      for (const c of calls) usedTools.push(c.name);
      // Tool args routinely carry PHI (memory content, health queries, report paths) — log the tool
      // name(s) only, never the arguments.
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
        // Per-call isolation: registry.execute throws for an unknown/denied tool name (e.g. a hallucinated name in a
        // parallel batch). Catch it and surface an error result matched to this tool_call_id so every call still gets
        // exactly one `tool` message (OpenAI ordering stays valid) and the good calls' work is not discarded.
        let resultText: string;
        try {
          // Thread the provider's per-call id through so a tool can build a collision-free idempotency key for two
          // parallel same-tool calls in this turn.
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
