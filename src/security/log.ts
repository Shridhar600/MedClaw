// Excludes error.message: domain errors echo user health content, and no log or errno field may carry PHI.
export function summarizeErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    const frame = error.stack?.split('\n')[1]?.trim();
    return frame ? `${error.name} (${frame})` : error.name;
  }
  return typeof error;
}
