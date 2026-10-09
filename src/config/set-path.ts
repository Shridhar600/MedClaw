/** The one supported config-set path language: trimmed, nonempty dotted identifiers. */
export interface ConfigSetPath {
  readonly segments: readonly string[];
  readonly canonical: string;
}

export type ConfigSetPathResult =
  | { kind: 'valid'; path: ConfigSetPath }
  | { kind: 'invalid'; reason: string };

export function parseConfigSetPath(input: string): ConfigSetPathResult {
  const segments = input.split('.').map((segment) => segment.trim());
  if (segments.some((segment) => ['__proto__', 'prototype', 'constructor'].includes(segment))) {
    return { kind: 'invalid', reason: 'Unsafe config path segment: prototype keys are refused.' };
  }
  if (segments.some((segment) => !/^[A-Za-z][A-Za-z0-9]*$/.test(segment))) {
    return { kind: 'invalid', reason: 'Refused config path: use nonempty dotted setting names; brackets are unsupported.' };
  }
  return { kind: 'valid', path: { segments, canonical: segments.join('.') } };
}
