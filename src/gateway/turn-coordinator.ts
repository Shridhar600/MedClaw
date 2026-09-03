import type { IncomingMessage } from '../channels/types';
import type { AgentRunResult, Message } from '../providers/types';
import { OnboardingFlow } from '../onboarding/flow';
import { OnboardingStore } from '../onboarding/store';
import { HEARTBEAT_NOOP } from '../scheduler/delivery-policy';
import {
  HeartbeatPreemptedError,
  LLMSemaphore,
  type SemaphorePriority,
} from '../tools/semaphore';
import { summarizeErrorForLog } from '../security';
import type { ProfileRuntime } from './runtime';

const SESSION_RESET_FAILURE_RESPONSE = "I couldn't start a fresh session right now. Please try again in a moment.";
const AGENT_FAILURE_RESPONSE = "I'm having trouble right now. Please try again in a moment.";
const SESSION_RESET_RESPONSE = 'Starting fresh session. Your health memory is preserved.';
const COMPACTION_RESPONSE = 'Compacted the conversation. Older turns are summarized; recent context is kept. Nothing is lost — ask me to look anything up.';

export const MAX_QUEUED_TURNS_WAITING = 2;

export type TurnEgress = (text: string) => Promise<void>;
export type EmergencyResponse = (input: string) => string | undefined;

export async function captureUserTurn(runtime: ProfileRuntime, incoming: IncomingMessage): Promise<void> {
  const pipeline = runtime.capturePipeline;
  if (!pipeline || incoming.text.trim().length === 0) return;
  try {
    await pipeline.ingest({
      profileId: String(runtime.profileId),
      source: 'chat',
      kind: 'narrative-note',
      payload: { text: incoming.text },
      ...(incoming.messageId ? { idempotencyKey: `chat:${incoming.chatId}:${incoming.messageId}` } : {}),
    });
  } catch (error) {
    console.warn('[gateway] per-turn narrative capture failed (continuing):', summarizeErrorForLog(error));
  }
}

export function scheduleBackgroundCapture(runtime: ProfileRuntime, incoming: IncomingMessage): void {
  runtime.trackBackgroundOperation('emergency capture', () => captureUserTurn(runtime, incoming));
}

export class TurnQueueFullError extends Error {
  constructor() {
    super('turn queue full');
    this.name = 'TurnQueueFullError';
  }
}

export interface HeartbeatTurnRequest {
  chatId: string;
  input: string;
  egress: TurnEgress;
  afterDelivery: (result: AgentRunResult) => Promise<void>;
}

export type HeartbeatTurnResult =
  | { status: 'sent'; result: AgentRunResult }
  | { status: 'noop'; result: AgentRunResult }
  | { status: 'preempted'; error: HeartbeatPreemptedError };

interface QueueEntry {
  execute: () => Promise<void>;
}

interface ChatQueue {
  user: QueueEntry[];
  heartbeat: QueueEntry[];
  active?: QueueEntry;
  draining: boolean;
}

export class TurnCoordinator {
  readonly maxQueuedTurnsWaiting = MAX_QUEUED_TURNS_WAITING;
  private readonly queues: Map<string, ChatQueue> = new Map();

  constructor(
    private readonly runtime: ProfileRuntime,
    private readonly semaphore: LLMSemaphore,
    private readonly reconcile?: (chatId: string) => Promise<void>,
  ) {}

  runUser(
    incoming: IncomingMessage,
    egress: TurnEgress,
    emergencyResponse: EmergencyResponse,
  ): Promise<string> {
    return this.enqueue(incoming.chatId, 'user', () =>
      this.executeUser(incoming, egress, emergencyResponse));
  }

  async runHeartbeat(request: HeartbeatTurnRequest): Promise<HeartbeatTurnResult> {
    try {
      const result = await this.enqueue(request.chatId, 'heartbeat', () =>
        this.executeHeartbeat(request));
      return result.text === HEARTBEAT_NOOP
        ? { status: 'noop', result }
        : { status: 'sent', result };
    } catch (error) {
      if (error instanceof HeartbeatPreemptedError) {
        return { status: 'preempted', error };
      }
      throw error;
    }
  }

  private enqueue<T>(chatId: string, priority: SemaphorePriority, operation: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(chatId) ?? { user: [], heartbeat: [], draining: false };
    const waitingCount = queue.user.length + queue.heartbeat.length;
    if (waitingCount >= this.maxQueuedTurnsWaiting) {
      return Promise.reject(new TurnQueueFullError());
    }

    if (priority === 'user') {
      this.semaphore.abortQueueEntry((meta) =>
        meta.chatId === chatId && meta.origin === 'heartbeat');
    }

    const promise = new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        execute: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        },
      };
      if (priority === 'user') {
        queue.user.push(entry);
      } else {
        queue.heartbeat.push(entry);
      }
    });

    this.queues.set(chatId, queue);
    if (!queue.draining) {
      queue.draining = true;
      void this.drain(chatId, queue);
    }
    return promise;
  }

  private async drain(chatId: string, queue: ChatQueue): Promise<void> {
    try {
      for (;;) {
        const entry = queue.user.shift() ?? queue.heartbeat.shift();
        if (!entry) return;
        queue.active = entry;
        await entry.execute();
        queue.active = undefined;
      }
    } finally {
      queue.active = undefined;
      queue.draining = false;
      if (queue.user.length === 0 && queue.heartbeat.length === 0) {
        if (this.queues.get(chatId) === queue) this.queues.delete(chatId);
      } else if (!queue.draining) {
        queue.draining = true;
        void this.drain(chatId, queue);
      }
    }
  }

  private async executeUser(
    incoming: IncomingMessage,
    egress: TurnEgress,
    emergencyResponse: EmergencyResponse,
  ): Promise<string> {
    const { chatId, text } = incoming;
    const sessions = this.requireSessions();

    if (text.trim() === '/new') {
      try {
        await sessions.resetSession(chatId);
      } catch (error) {
        console.error('[gateway] Failed to reset session (keeping existing context):', summarizeErrorForLog(error));
        return this.emit(egress, SESSION_RESET_FAILURE_RESPONSE);
      }
      return this.emit(egress, SESSION_RESET_RESPONSE);
    }

    if (text.trim() === '/compact') {
      await sessions.runCompaction(chatId);
      return this.emit(egress, COMPACTION_RESPONSE);
    }

    const agentInput = this.buildAgentInput(incoming);

    if (incoming.mediaError) {
      await captureUserTurn(this.runtime, incoming);
      const failureTrace: Message[] = [
        { role: 'user', content: agentInput },
        { role: 'assistant', content: `[Media upload failure]\n${incoming.mediaError}` },
      ];
      try {
        await sessions.recordTurn(chatId, failureTrace);
      } catch (error) {
        console.error('[gateway] Failed to persist media upload error turn:', summarizeErrorForLog(error));
      }
      try {
        await egress(incoming.mediaError);
      } catch (error) {
        console.error('[gateway] Failed to send media upload error:', summarizeErrorForLog(error));
      }
      return incoming.mediaError;
    }

    const onboarding = await this.handleOnboarding(chatId, text);
    if (onboarding) {
      await captureUserTurn(this.runtime, incoming);
      await egress(onboarding);
      return onboarding;
    }

    // Keep the post-onboarding emergency check as a separate safety boundary. The Router normally
    // handles the same emergency before this turn enters the coordinator.
    const postOnboardingEmergency = emergencyResponse(text);
    if (postOnboardingEmergency) {
      try {
        await sessions.recordTurn(chatId, [
          { role: 'user', content: agentInput },
          { role: 'assistant', content: postOnboardingEmergency },
        ]);
      } catch (error) {
        console.error('[gateway] Failed to persist emergency turn (sending guidance anyway):', summarizeErrorForLog(error));
      }
      try {
        await egress(postOnboardingEmergency);
      } catch (error) {
        console.error('[gateway] Failed to send emergency response:', summarizeErrorForLog(error));
      }
      scheduleBackgroundCapture(this.runtime, incoming);
      return postOnboardingEmergency;
    }

    await captureUserTurn(this.runtime, incoming);

    let result: AgentRunResult;
    try {
      const history = await sessions.prepareHistory(chatId);
      result = await this.requireAgentLoop().run(agentInput, history, { chatId, mode: 'chat' });
    } catch (error) {
      console.error('[gateway] Agent error:', summarizeErrorForLog(error));
      await this.persistFailureTrace(chatId, agentInput, AGENT_FAILURE_RESPONSE);
      try {
        await egress(AGENT_FAILURE_RESPONSE);
      } catch (sendError) {
        console.error('[gateway] Failed to send fallback response:', summarizeErrorForLog(sendError));
      }
      return AGENT_FAILURE_RESPONSE;
    }

    let persistFailed = false;
    try {
      await sessions.recordTurn(chatId, [
        { role: 'user', content: agentInput },
        ...result.trace,
      ]);
      await sessions.recordPromptUsage(chatId, result.lastPromptTokens);
    } catch (error) {
      persistFailed = true;
      console.error(
        '[gateway] Pre-send persistence error (sending response anyway; logged divergence):',
        summarizeErrorForLog(error),
      );
    }

    try {
      await egress(result.text);
    } catch (error) {
      console.error('[gateway] Send error:', summarizeErrorForLog(error));
      try {
        await egress(AGENT_FAILURE_RESPONSE);
      } catch (fallbackError) {
        console.error('[gateway] Failed to send fallback response:', summarizeErrorForLog(fallbackError));
      }
      return result.text;
    }

    // Keep the production contract: a failed transcript write must not schedule a policy
    // reconciliation from a turn whose durable state is uncertain.
    if (!persistFailed && this.reconcile) {
      try {
        await this.reconcile(chatId);
      } catch (error) {
        console.error('[gateway] Reconciliation error:', summarizeErrorForLog(error));
      }
    }
    return result.text;
  }

  private async executeHeartbeat(request: HeartbeatTurnRequest): Promise<AgentRunResult> {
    const sessions = this.requireSessions();
    const history = await sessions.prepareHistory(request.chatId);
    const result = await this.requireAgentLoop().run(
      request.input,
      history,
      { chatId: request.chatId, origin: 'heartbeat', mode: 'heartbeat' },
    );

    await sessions.recordTurn(request.chatId, [
      { role: 'user', content: request.input },
      ...result.trace,
    ], 'heartbeat');
    try {
      await sessions.recordPromptUsage(request.chatId, result.lastPromptTokens);
    } catch (error) {
      console.warn('[gateway] Failed to persist heartbeat prompt usage; continuing to delivery:', summarizeErrorForLog(error));
    }

    if (result.text !== HEARTBEAT_NOOP) {
      await request.egress(result.text);
    }
    await request.afterDelivery(result);
    return result;
  }

  private async handleOnboarding(chatId: string, input: string): Promise<string | undefined> {
    const workspace = this.runtime.workspace;
    const config = this.runtime.config;
    const sessions = this.requireSessions();
    if (input.trim() === '/onboarding restart' || input.trim() === '/profile update') {
      const flow = new OnboardingFlow(
        new OnboardingStore(workspace),
        workspace,
        config.heartbeat.timezone,
        config.emergency?.keywords,
      );
      const result = await flow.handle('restart onboarding');
      try {
        await sessions.recordTurn(chatId, [
          { role: 'user', content: input },
          { role: 'assistant', content: result.response },
        ]);
      } catch (error) {
        console.error('[gateway] Failed to persist onboarding turn (returning response anyway):', summarizeErrorForLog(error));
      }
      return result.response;
    }

    const flow = new OnboardingFlow(
      new OnboardingStore(workspace),
      workspace,
      config.heartbeat.timezone,
      config.emergency?.keywords,
    );
    if (await flow.isComplete()) return undefined;

    const result = await flow.handle(input);
    if (!result.response) return undefined;
    try {
      await sessions.recordTurn(chatId, [
        { role: 'user', content: input },
        { role: 'assistant', content: result.response },
      ]);
    } catch (error) {
      console.error('[gateway] Failed to persist onboarding turn (returning response anyway):', summarizeErrorForLog(error));
    }
    return result.response;
  }

  private buildAgentInput(incoming: IncomingMessage): string {
    const parts: string[] = [incoming.text];
    if (incoming.mediaPath) {
      parts.push('', `Uploaded media path (relative to workspace): ${incoming.mediaPath}`);
    }
    if (incoming.replyToMessageId) {
      parts.push('', `Reply to message id: ${incoming.replyToMessageId}`);
    }
    if (incoming.userId) {
      parts.push('', `User id: ${incoming.userId}`);
    }
    return parts.join('\n');
  }

  private async persistFailureTrace(chatId: string, userContent: string, fallback: string): Promise<void> {
    try {
      await this.runtime.sessions?.recordTurn(chatId, [
        { role: 'user', content: userContent },
        { role: 'assistant', content: fallback },
      ]);
    } catch (error) {
      console.error('[gateway] Failed to persist agent failure trace (continuing):', summarizeErrorForLog(error));
    }
  }

  private requireSessions(): NonNullable<ProfileRuntime['sessions']> {
    if (!this.runtime.sessions) throw new Error('Session manager unavailable');
    return this.runtime.sessions;
  }

  private requireAgentLoop(): NonNullable<ProfileRuntime['agentLoop']> {
    if (!this.runtime.agentLoop) throw new Error('Agent loop unavailable');
    return this.runtime.agentLoop;
  }

  private async emit(egress: TurnEgress, text: string): Promise<string> {
    await egress(text);
    return text;
  }
}
