# Heartbeat Schedule

Current runtime status:
- Scheduler runtime is active when `heartbeat.enabled` is true and a channel is available.
- This file is derived from the durable JSON heartbeat store and synchronized by runtime/tools.
- Delivery state shows whether a job is ready, snoozed, waiting for retry, or dead-lettered.
- Retry and acknowledgement fields reflect runtime control state, not just cron metadata.
- Policy-managed system jobs are derived from structured files in `medications/`, `conditions/`, and `goals/`.

## Jobs
- (none)
