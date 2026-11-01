import type { DiagnosticEvent, DiagnosticSink } from '../../ports';
import { MEDIA_MAX_FILE_BYTES, PAIRING_ATTEMPTS_PER_CHAT_PER_DAY } from '../../ports';

/** Local daemon output. Only closed vocabulary and checked numbers cross this edge. */
export class ConsoleDiagnosticSink implements DiagnosticSink {
  constructor(private readonly write: (line: string) => void = line => console.info(line)) {}

  emit(event: DiagnosticEvent): void {
    try {
      const line = diagnosticLine(event);
      if (line !== undefined) this.write(line);
    } catch {
      // Output is optional. A broken writer or malformed runtime value cannot affect the operation.
    }
  }
}

function diagnosticLine(event: DiagnosticEvent): string | undefined {
  const { stage, outcome, durationMs } = event;
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > Number.MAX_SAFE_INTEGER) return;
  let fields: string;
  switch (stage) {
    case 'owner-admission': {
      if (outcome === 'admitted' || outcome === 'pairing-only') fields = `outcome=${outcome}`;
      else if (outcome === 'refused') {
        const { reason } = event;
        if (![
          'unavailable', 'owner-mismatch', 'not-owner', 'non-private-chat',
          'missing-transport-identity', 'already-bound',
        ].includes(reason)) return;
        fields = `outcome=refused reason=${reason}`;
      }
      else return;
      break;
    }
    case 'pairing': {
      if (outcome === 'paired' || outcome === 'already-paired' || outcome === 'prompt') fields = `outcome=${outcome}`;
      else if (['refused', 'invalid', 'expired', 'limited', 'unavailable'].includes(outcome) && 'reason' in event) {
        const { reason } = event;
        if (![
          'owner-mismatch', 'already-bound', 'not-a-private-pairing-identity', 'code-mismatch',
          'code-expired', 'daily-allowance-spent', 'candidate-capacity-reached', 'record-unavailable',
        ].includes(reason)) return;
        fields = `outcome=${outcome} reason=${reason}`;
        const attempts = 'attempts' in event ? event.attempts : undefined;
        if (attempts !== undefined) {
          if (reason !== 'daily-allowance-spent' || !boundedInteger(attempts, PAIRING_ATTEMPTS_PER_CHAT_PER_DAY)) return;
          fields += ` attempts=${attempts}`;
        }
      } else return;
      break;
    }
    case 'media-intake': {
      if (outcome === 'saved') {
        const { bytes } = event;
        if (!boundedInteger(bytes, MEDIA_MAX_FILE_BYTES)) return;
        fields = `outcome=saved bytes=${bytes}`;
      }
      else if (outcome === 'refused') {
        const { reason } = event;
        if (![
          'unsupported', 'too-large', 'timeout', 'queue-full', 'aborted', 'source-failed', 'advertised-too-large',
        ].includes(reason)) return;
        fields = `outcome=refused reason=${reason}`;
      }
      else return;
      break;
    }
    case 'start-stop': {
      const { operation } = event;
      if (!['start', 'promotion', 'stop'].includes(operation)) return;
      fields = `operation=${operation} outcome=${outcome}`;
      if (outcome === 'started') { if (operation === 'stop') return; }
      else if (outcome === 'stopped') { if (operation !== 'stop') return; }
      else if (outcome === 'refused' || outcome === 'failed') {
        const { reason } = event;
        if (![
          'admission-refused', 'already-running', 'build-failed', 'previous-work-unsettled',
          'shutdown-in-progress', 'release-failed',
        ].includes(reason)) return;
        fields += ` reason=${reason}`;
      }
      else return;
      break;
    }
    default: return;
  }
  return `[diagnostic] stage=${stage} ${fields} durationMs=${durationMs}`;
}

function boundedInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}
