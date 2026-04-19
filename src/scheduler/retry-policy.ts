import type { HeartbeatJob, HeartbeatLastOutcome, UpdateHeartbeatJobInput } from './types';

interface RetryDecisionInput {
  outcome: HeartbeatLastOutcome;
  failedAt: string;
  errorMessage: string;
}

interface RetryPolicyOptions {
  backoffMinutes: number;
}

type RetryDecision =
  | { action: 'none' }
  | { action: 'retry'; patch: UpdateHeartbeatJobInput }
  | { action: 'dead-letter'; patch: UpdateHeartbeatJobInput };

function addMinutes(isoTimestamp: string, minutes: number): string {
  return new Date(new Date(isoTimestamp).getTime() + (minutes * 60 * 1000)).toISOString();
}

function isRetryEligibleOutcome(outcome: HeartbeatLastOutcome): boolean {
  return outcome === 'error';
}

export function determineRetryAction(
  job: HeartbeatJob,
  input: RetryDecisionInput,
  options: RetryPolicyOptions,
): RetryDecision {
  if (!isRetryEligibleOutcome(input.outcome)) {
    return { action: 'none' };
  }

  const nextRetryCount = job.retryCount + 1;
  const basePatch: UpdateHeartbeatJobInput = {
    lastError: input.errorMessage,
    lastOutcome: input.outcome,
    lastOutcomeAt: input.failedAt,
    lastAttemptAt: input.failedAt,
    retryCount: nextRetryCount,
  };

  if (nextRetryCount > job.maxRetries) {
    return {
      action: 'dead-letter',
      patch: {
        ...basePatch,
        deliveryState: 'dead-letter',
        nextRetryAt: undefined,
        deadLetterReason: `Retry budget exhausted: ${input.errorMessage}`,
      },
    };
  }

  return {
    action: 'retry',
    patch: {
      ...basePatch,
      deliveryState: 'retry-wait',
      nextRetryAt: addMinutes(input.failedAt, options.backoffMinutes),
      deadLetterReason: undefined,
    },
  };
}
