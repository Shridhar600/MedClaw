import type { HeartbeatPolicyConfig } from '../config/types';
import type { HeartbeatJob } from './types';

export const HEARTBEAT_NOOP = 'HEARTBEAT_NOOP';

interface DeliveryDecisionInput {
  now: Date;
  quietHours: HeartbeatPolicyConfig['quietHours'];
  lastChatActivityAt?: Date;
  skipIfChatActiveWithinMinutes: number;
}

type DeliveryDecision =
  | { action: 'run' }
  | { action: 'skip'; reason: 'skipped-quiet-hours' | 'skipped-recent-activity' };

function toMinutesOfDay(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return undefined;
  }
  return (hours * 60) + minutes;
}

function isWithinQuietHours(now: Date, quietHours: HeartbeatPolicyConfig['quietHours']): boolean {
  if (!quietHours.enabled) {
    return false;
  }

  const start = toMinutesOfDay(quietHours.start);
  const end = toMinutesOfDay(quietHours.end);
  if (start === undefined || end === undefined) {
    return false;
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (start === end) {
    return true;
  }
  if (start < end) {
    return nowMinutes >= start && nowMinutes < end;
  }
  return nowMinutes >= start || nowMinutes < end;
}

function wasChatRecentlyActive(
  now: Date,
  lastChatActivityAt: Date | undefined,
  skipIfChatActiveWithinMinutes: number,
): boolean {
  if (!lastChatActivityAt || skipIfChatActiveWithinMinutes <= 0) {
    return false;
  }
  const deltaMs = now.getTime() - lastChatActivityAt.getTime();
  if (deltaMs < 0) {
    return false;
  }
  return deltaMs <= skipIfChatActiveWithinMinutes * 60 * 1000;
}

export function decideHeartbeatDelivery(
  _job: HeartbeatJob,
  input: DeliveryDecisionInput,
): DeliveryDecision {
  if (isWithinQuietHours(input.now, input.quietHours)) {
    return { action: 'skip', reason: 'skipped-quiet-hours' };
  }

  if (wasChatRecentlyActive(input.now, input.lastChatActivityAt, input.skipIfChatActiveWithinMinutes)) {
    return { action: 'skip', reason: 'skipped-recent-activity' };
  }

  return { action: 'run' };
}
