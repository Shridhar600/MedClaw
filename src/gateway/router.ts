import * as fs from 'fs';
import * as path from 'path';
import type { EffectiveConfig } from '../config/types';
import type { AdmittedMessage, ChatType } from '../channels';
import type { ProfileId } from '../profiles';
import type { OwnerAdmissionService, PairingResult } from '../profiles';
import {
  PAIRING_COMPLETE_TEXT,
  PAIRING_EXPIRED_TEXT,
  PAIRING_INVALID_TEXT,
  PAIRING_PROMPT_TEXT,
  PAIRING_UNAVAILABLE_TEXT,
  refusalTextFor,
} from '../profiles';
import type { TransportIdentity } from '../ports/owner-state';
import { EMERGENCY_RESPONSE, isEmergencyInput } from '../safety/emergency-detector';
import {
  PathContainmentError,
  resolveContainedPath,
  secureCopyFile,
  secureMkdir,
  summarizeErrorForLog,
  tightenFile,
} from '../security';
import type { ProfileRuntime } from './runtime';
import {
  scheduleBackgroundCapture,
  TurnQueueFullError,
  type TurnEgress,
} from './turn-coordinator';

const UNRECOGNIZED_CHAT_RESPONSE =
  'This chat is not recognized. This is a private health assistant; new chats cannot be added over this channel.';
/** Canned reply for a paired chat whose profile runtime cannot be resolved this turn. Temporary, never policy. */
const PROFILE_DEGRADED_RESPONSE =
  "This chat's profile is temporarily unavailable. Please try again in a moment.";
const EMPTY_MESSAGE_RESPONSE = "I didn't catch any message. Send some text or an attachment and I'll take a look.";
const TURN_QUEUE_FULL_RESPONSE = "I'm still processing your previous message. Please try again in a moment.";
const STAGED_MEDIA_FAILURE_RESPONSE = 'Failed to store uploaded file. Please try uploading it again.';

export interface GatewayMessageRouterDeps {
  config: EffectiveConfig;
  runtime?: ProfileRuntime;
  stagingDir: string | undefined;
  stagingBaseDir?: string;
  buildBootStatusText: () => string;
  resolveRuntime?: (profileId: ProfileId) => Promise<ProfileRuntime | undefined>;
  /** The only authority for "who may talk to this owner". Required; there is no fallback path. */
  admission: OwnerAdmissionService;
  /** The owner identity `admission` is configured for: the dispatch target once admission proves the chat is the owner. */
  ownerId: ProfileId;
}

/** Canned pairing replies. Pairing is never a health answer. */
const PAIRING_RESULT_TEXT: Record<PairingResult['kind'], string | undefined> = {
  paired: PAIRING_COMPLETE_TEXT,
  'already-paired': PAIRING_COMPLETE_TEXT,
  prompt: PAIRING_PROMPT_TEXT,
  invalid: PAIRING_INVALID_TEXT,
  expired: PAIRING_EXPIRED_TEXT,
  limited: undefined,
  refused: UNRECOGNIZED_CHAT_RESPONSE,
  unavailable: PAIRING_UNAVAILABLE_TEXT,
};

interface StagedMedia {
  sourcePath: string;
  fileName: string;
}

interface TrustedDirectory {
  lexical: string;
  real: string;
}

export class GatewayMessageRouter {
  constructor(private readonly deps: GatewayMessageRouterDeps) {}

  async route(incoming: AdmittedMessage, egress: TurnEgress): Promise<string | undefined> {
    const { text } = incoming;
    const admission = this.deps.admission;
    const identity = transportIdentityOf(incoming);
    const decision = admission.inspect(identity);
    if (decision.kind === 'refused') {
      this.deleteStagedMedia(incoming.mediaPath);
      return this.emitSafely(
        egress,
        this.emergencyResponse(text) ?? refusalTextFor(decision.reason),
        'Failed to send admission refusal',
      );
    }
    if (decision.kind === 'pairing-only') {
      return this.routePairing(incoming, egress, identity);
    }

    // Admission has proved this chat is the bound owner, so the owner identity is the only dispatch target.
    const admittedOwnerId = this.deps.ownerId;

    if (admission.isRedeliveredPairingEvent(identity)) {
      this.deleteStagedMedia(incoming.mediaPath);
      return this.emitSafely(egress, PAIRING_COMPLETE_TEXT, 'Failed to answer redelivered pairing event');
    }

    if (text.trim().length === 0 && !incoming.mediaPath && !incoming.mediaError) {
      return this.emitSafely(egress, EMPTY_MESSAGE_RESPONSE, 'Failed to send empty-message response');
    }

    const emergency = this.emergencyResponse(text);
    if (emergency) {
      return this.routeEmergency(incoming, egress, emergency, admittedOwnerId);
    }

    // Owner chat: the only path that may reach a clinical runtime.
    const profileId = admittedOwnerId ?? this.deps.ownerId;
    // A chat admission refused was already answered above and never reaches this line.
    const runtime = await this.resolveRuntimeFor(profileId);
    if (!runtime) {
      this.deleteStagedMedia(incoming.mediaPath);
      return this.emitSafely(
        egress,
        PROFILE_DEGRADED_RESPONSE,
        'Failed to respond to degraded profile chat',
      );
    }

    const routedIncoming = { ...incoming };
    this.adoptStagedMedia(routedIncoming, runtime);

    if (text.trim() === '/status') {
      const statusText = this.deps.buildBootStatusText();
      await egress(statusText);
      return statusText;
    }

    try {
      return await this.requireCoordinator(runtime).runUser(
        routedIncoming,
        egress,
        (input: string) => this.emergencyResponse(input),
      );
    } catch (error) {
      if (error instanceof TurnQueueFullError) {
        return this.emitSafely(egress, TURN_QUEUE_FULL_RESPONSE, 'Failed to send turn-queue-full response');
      }
      throw error;
    }
  }

  private async routePairing(
    incoming: AdmittedMessage,
    egress: TurnEgress,
    identity: TransportIdentity,
  ): Promise<string | undefined> {
    this.deleteStagedMedia(incoming.mediaPath);

    const emergency = this.emergencyResponse(incoming.text);
    if (emergency) {
      return this.emitSafely(egress, emergency, 'Failed to send emergency response');
    }

    const result = await this.deps.admission.handlePairing(identity, incoming.text);
    const reply = PAIRING_RESULT_TEXT[result.kind];
    if (reply === undefined) return undefined;
    return this.emitSafely(egress, reply, 'Failed to send pairing response');
  }

  private emergencyResponse(input: string): string | undefined {
    return isEmergencyInput(input, this.deps.config.emergency?.keywords)
      ? EMERGENCY_RESPONSE
      : undefined;
  }

  private buildAgentInput(incoming: AdmittedMessage): string {
    const parts: string[] = [incoming.text];
    if (incoming.mediaPath) parts.push('', `Uploaded media path (relative to workspace): ${incoming.mediaPath}`);
    if (incoming.replyToMessageId) parts.push('', `Reply to message id: ${incoming.replyToMessageId}`);
    return parts.join('\n');
  }

  private async resolveRuntimeFor(profileId: ProfileId): Promise<ProfileRuntime | undefined> {
    const resolver = this.deps.resolveRuntime;
    if (!resolver) return this.deps.runtime;
    try {
      return await resolver(profileId);
    } catch (error) {
      console.warn('[gateway] Failed to resolve profile runtime; degrading this turn:', summarizeErrorForLog(error));
      return undefined;
    }
  }

  private async persistEmergencyTurn(
    incoming: AdmittedMessage,
    emergency: string,
    runtime: ProfileRuntime,
  ): Promise<void> {
    try {
      await runtime.sessions?.recordTurn(incoming.chatId, [
        { role: 'user', content: this.buildAgentInput(incoming) },
        { role: 'assistant', content: emergency },
      ]);
    } catch (error) {
      console.error('[gateway] Failed to persist emergency turn (sending guidance anyway):', summarizeErrorForLog(error));
    }
  }

  private async routeEmergency(
    incoming: AdmittedMessage,
    egress: TurnEgress,
    emergency: string,
    admittedOwnerId?: ProfileId,
  ): Promise<string> {
    const runtime = admittedOwnerId ? await this.resolveRuntimeFor(admittedOwnerId) : undefined;
    const emergencyIncoming = { ...incoming };
    if (path.isAbsolute(emergencyIncoming.mediaPath ?? '')) {
      this.deleteStagedMedia(emergencyIncoming.mediaPath);
      emergencyIncoming.mediaPath = undefined;
    } else if (!runtime) {
      this.deleteStagedMedia(emergencyIncoming.mediaPath);
    }
    if (runtime) {
      this.adoptStagedMedia(emergencyIncoming, runtime);
      await this.persistEmergencyTurn(emergencyIncoming, emergency, runtime);
    }
    await this.emitSafely(egress, emergency, 'Failed to send emergency response');
    if (runtime) this.scheduleBackgroundCapture(emergencyIncoming, runtime);
    return emergency;
  }

  private scheduleBackgroundCapture(incoming: AdmittedMessage, runtime: ProfileRuntime): void {
    scheduleBackgroundCapture(runtime, incoming);
  }

  private adoptStagedMedia(incoming: AdmittedMessage, runtime: ProfileRuntime): void {
    if (!incoming.mediaPath || !path.isAbsolute(incoming.mediaPath)) return;
    const staged = this.inspectStagedMedia(incoming.mediaPath);
    if (!staged) {
      this.deleteStagedMedia(incoming.mediaPath);
      incoming.mediaPath = undefined;
      incoming.mediaError = incoming.mediaError ?? STAGED_MEDIA_FAILURE_RESPONSE;
      return;
    }

    let destinationPath: string | undefined;
    let destinationCreated = false;
    try {
      const reportsDir = path.join(runtime.workspace, 'reports');
      try {
        const reportsStat = fs.lstatSync(reportsDir);
        if (reportsStat.isSymbolicLink() || !reportsStat.isDirectory()) {
          throw new PathContainmentError('symlink');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      secureMkdir(reportsDir);
      const trustedReportsDir = resolveContainedPath(runtime.workspace, 'reports');
      const destination = resolveContainedPath(trustedReportsDir, staged.fileName);
      destinationPath = destination;
      try {
        fs.renameSync(staged.sourcePath, destination);
        destinationCreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        const sourceStat = fs.lstatSync(staged.sourcePath);
        if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error('staged media source is not a regular file');
        secureCopyFile(staged.sourcePath, destination);
        destinationCreated = true;
        fs.unlinkSync(staged.sourcePath);
      }
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('staged media destination is not a regular file');
      tightenFile(destination);
      incoming.mediaPath = `reports/${staged.fileName}`;
    } catch (error) {
      console.warn('[gateway] Failed to move staged media into the profile workspace:', summarizeErrorForLog(error));
      if (destinationCreated && destinationPath) {
        try {
          const destinationStat = fs.lstatSync(destinationPath);
          if (destinationStat.isFile() || destinationStat.isSymbolicLink()) fs.unlinkSync(destinationPath);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[gateway] Failed to clean up staged media destination:', summarizeErrorForLog(cleanupError));
          }
        }
      }
      this.deleteStagedMedia(staged.sourcePath);
      incoming.mediaPath = undefined;
      incoming.mediaError = incoming.mediaError ?? STAGED_MEDIA_FAILURE_RESPONSE;
    }
  }

  private inspectStagedMedia(mediaPath: string): StagedMedia | undefined {
    const root = trustedDirectory(this.deps.stagingDir, this.deps.stagingBaseDir);
    if (!root) return undefined;
    const candidate = path.resolve(mediaPath);
    const relative = path.relative(root.lexical, candidate);
    if (
      relative.length === 0
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
      || relative.includes(path.sep)
    ) return undefined;
    try {
      const lexicalStat = fs.lstatSync(candidate);
      if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) return undefined;
      const canonical = fs.realpathSync(candidate);
      const canonicalRelative = path.relative(root.real, canonical);
      if (
        canonicalRelative.length === 0
        || canonicalRelative === '..'
        || canonicalRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(canonicalRelative)
        || canonicalRelative.includes(path.sep)
      ) return undefined;
      const contained = resolveContainedPath(root.real, canonicalRelative);
      const stat = fs.lstatSync(contained);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      return { sourcePath: candidate, fileName: canonicalRelative };
    } catch {
      return undefined;
    }
  }

  private deleteStagedMedia(mediaPath: string | undefined): void {
    if (!mediaPath || !path.isAbsolute(mediaPath)) return;
    const root = trustedDirectory(this.deps.stagingDir, this.deps.stagingBaseDir);
    if (!root) return;
    const candidate = path.resolve(mediaPath);
    const relative = path.relative(root.lexical, candidate);
    if (
      relative.length === 0
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
      || relative.includes(path.sep)
    ) return;
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(candidate);
        return;
      }
      if (!stat.isFile()) return;
      const canonical = fs.realpathSync(candidate);
      const canonicalRelative = path.relative(root.real, canonical);
      if (
        canonicalRelative.length === 0
        || canonicalRelative === '..'
        || canonicalRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(canonicalRelative)
        || canonicalRelative.includes(path.sep)
      ) return;
      fs.unlinkSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') console.warn('[gateway] Failed to delete staged media:', summarizeErrorForLog(error));
    }
  }

  private async emitSafely(egress: TurnEgress, text: string, label: string): Promise<string> {
    try {
      await egress(text);
    } catch (error) {
      console.error(`[gateway] ${label}:`, summarizeErrorForLog(error));
    }
    return text;
  }

  private requireCoordinator(runtime: ProfileRuntime): NonNullable<ProfileRuntime['turnCoordinator']> {
    if (!runtime?.turnCoordinator) throw new Error('Turn coordinator unavailable');
    return runtime.turnCoordinator;
  }
}

export type IncomingMessageLike = {
  channel?: string;
  chatId: string;
  userId: string;
  chatType?: ChatType;
  eventId?: string;
};

export function transportIdentityOf(incoming: IncomingMessageLike): TransportIdentity {
  return {
    channel: incoming.channel ?? '',
    chatId: incoming.chatId,
    userId: incoming.userId,
    chatType: incoming.chatType,
    eventId: incoming.eventId ?? '',
  };
}

function trustedDirectory(directory: string | undefined, trustedBaseDir?: string): TrustedDirectory | undefined {
  if (!directory) return undefined;
  const absolute = path.resolve(directory);
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    if (trustedBaseDir && !hasTrustedAncestors(trustedBaseDir, absolute)) return undefined;
    const real = fs.realpathSync(absolute);
    if (trustedBaseDir) {
      const realBase = fs.realpathSync(path.resolve(trustedBaseDir));
      if (!isContained(realBase, real)) return undefined;
    }
    return { lexical: absolute, real };
  } catch {
    return undefined;
  }
}

function hasTrustedAncestors(trustedBaseDir: string, directory: string): boolean {
  const base = path.resolve(trustedBaseDir);
  const relative = path.relative(base, directory);
  if (
    relative.length === 0
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) return false;
  try {
    const baseStat = fs.lstatSync(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) return false;
    let current = base;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        return false;
      }
      if (stat.isSymbolicLink()) return false;
      if (!stat.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isContained(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative.length === 0
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}
