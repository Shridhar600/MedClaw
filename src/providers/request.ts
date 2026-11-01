export const PROVIDER_REQUEST_TIMEOUT_MS = 180_000;

export function firstChoice<T>(choices: readonly T[] | undefined): T {
  const choice = choices?.[0];
  if (choice === undefined) throw new Error('provider returned no choices');
  return choice;
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // The tool layer refuses the empty call, so the model can retry.
  }
  console.warn('[provider] tool call arguments were not a JSON object; passing an empty call');
  return {};
}
