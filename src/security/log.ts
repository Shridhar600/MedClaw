// PHI-safe error formatting for logs and persisted error fields.
//
// Deliberately excludes error.message: agent/session/provider errors in this
// domain can echo user health content (PHI) into their messages, and neither
// console logs nor on-disk error fields (e.g. heartbeat lastError) may carry
// it (see gateway-media-flow PHI-guard tests). The top stack frame gives the
// debuggable location without the message body.
export function summarizeErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    const frame = error.stack?.split('\n')[1]?.trim();
    return frame ? `${error.name} (${frame})` : error.name;
  }
  return typeof error;
}
