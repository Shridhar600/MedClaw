import type { AppConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';
import type { ProfileRuntime } from '../../src/gateway/runtime';
import { TurnCoordinator } from '../../src/gateway/turn-coordinator';
import { LLMSemaphore } from '../../src/tools/semaphore';
import { HeartbeatStore } from '../../src/scheduler/store';
import { HeartbeatScheduler } from '../../src/scheduler/runtime';
import type { HeartbeatJob } from '../../src/scheduler/types';

type GatewayWithRuntime = {
  runtime: ProfileRuntime;
};

/** Attach a structural runtime double to a Gateway without exercising the production boot path. */
export function attachGatewayTestRuntime(
  gateway: unknown,
  config: AppConfig,
  overrides: Record<string, unknown> = {},
): ProfileRuntime {
  const runtime: Record<string, unknown> = {
    profileId: 'default' as ProfileId,
    workspace: config.memory?.workspace ?? '',
    config,
    promptMode: 'per-turn',
    trackOperation: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    trackBackgroundOperation: (_label: string, operation: () => Promise<void>): void => {
      try {
        void operation().catch(() => undefined);
      } catch {
        // Test-only runtime double: background failure is intentionally swallowed.
      }
    },
    beginStopping: (): void => undefined,
    initializeScheduler: async (options: {
      schedulerPaths: { storePath: string; auditLogPath: string };
      runScheduledJob: (job: HeartbeatJob) => Promise<void>;
    }): Promise<void> => {
      const heartbeatConfig = config.heartbeat;
      const scheduler = new HeartbeatScheduler(
        new HeartbeatStore(options.schedulerPaths.storePath),
        options.runScheduledJob,
        heartbeatConfig.timezone,
        {
          auditLogPath: options.schedulerPaths.auditLogPath,
          defaultMaxRetries: heartbeatConfig.retry.maxRetries,
          maxGlobalTriggersPerMinute: heartbeatConfig.rateLimit.maxGlobalTriggersPerMinute,
          maxPerChatTriggersPerMinute: heartbeatConfig.rateLimit.maxPerChatTriggersPerMinute,
          recoveryEnabled: heartbeatConfig.recovery.enabled,
          recoveryWindowMinutes: heartbeatConfig.recovery.windowMinutes,
          retryBackoffMinutes: heartbeatConfig.retry.backoffMinutes,
        },
      );
      await scheduler.start();
      runtime.scheduler = scheduler;
    },
    drainAndClose: async (): Promise<void> => {
      const scheduler = runtime.scheduler as { stop?: () => Promise<void> } | undefined;
      await scheduler?.stop?.();
      const sessions = runtime.sessions as { drainCompactions?: () => Promise<void> } | undefined;
      await sessions?.drainCompactions?.();
      const store = runtime.store as { close?: () => void } | undefined;
      store?.close?.();
    },
    ...overrides,
  };
  if (!runtime.turnCoordinator) {
    const semaphore = (runtime.semaphore as LLMSemaphore | undefined) ?? new LLMSemaphore();
    runtime.turnCoordinator = new TurnCoordinator(
      runtime as unknown as ProfileRuntime,
      semaphore,
    );
  }
  (gateway as GatewayWithRuntime).runtime = runtime as unknown as ProfileRuntime;
  return runtime as unknown as ProfileRuntime;
}
