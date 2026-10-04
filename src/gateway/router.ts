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
  PAIRING_LIMITED_TEXT,
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
/** RR-STRUCT R-S5b: the RR-4 interim refusal is RETIRED (paired non-default chats are now
 *  dispatched to their own runtime — see `route()`). What remains is the GENUINE-failure path:
 *  the chat IS paired but its profile's runtime cannot be resolved this turn (a degraded
 *  profile whose build keeps failing). That is temporary, never policy — hence new wording. */
const PROFILE_DEGRADED_RESPONSE =
  "This chat's profile is temporarily unavailable. Please try again in a moment.";
const EMPTY_MESSAGE_RESPONSE = "I didn't catch any message. Send some text or an attachment and I'll take a look.";
const TURN_QUEUE_FULL_RESPONSE = "I'm still processing your previous message. Please try again in a moment.";
const STAGED_MEDIA_FAILURE_RESPONSE = 'Failed to store uploaded file. Please try uploading it again.';

export interface GatewayMessageRouterDeps {
  config: EffectiveConfig;
  runtime?: ProfileRuntime;
  /**
   * The owner-scoped staging lane, or `undefined` when this Gateway has no owner workspace to stage
   * into. `undefined` is a real, safe state: nothing can be adopted and nothing is deleted, which is
   * the correct outcome for a configuration that names no owner.
   */
  stagingDir: string | undefined;
  stagingBaseDir?: string;
  buildBootStatusText: () => string;
  /**
   * RR-STRUCT R-S5b (mini-plan v3 §3.2): per-profile runtime resolution, injected by the
   * Gateway and backed by `ProfileRuntimeManager.get`. Absent (unit tests that construct a
   * Router directly with a single runtime), every dispatch falls back to `deps.runtime`.
   * Must never reject to the Router — but the Router treats a rejection the same as
   * `undefined` (degraded profile → canned reply, never a throw) so a misbehaving resolver
   * cannot crash the daemon either.
   */
  resolveRuntime?: (profileId: ProfileId) => Promise<ProfileRuntime | undefined>;
  /**
   * S1 admission: the ONLY authority for "who may talk to this owner".
   *
   * REQUIRED. There is no optional fallback and no legacy path around it. The Router used to resolve a
   * chat to an identity through `ProfileRegistry`, and when no registry was attached it fell back to
   * `config.profiles.defaultProfileId` for ANY chat — a silent grant. Plan 15 §5 requires that "New core
   * APIs must not have an optional admission fallback", so the dependency is non-optional and every
   * dispatch target comes from the admission decision.
   */
  admission: OwnerAdmissionService;
  /**
   * The owner identity `admission` is configured for. REQUIRED: it is the dispatch target once admission
   * has proved the chat IS that owner. Never inferred, never defaulted.
   */
  ownerId: ProfileId;
}

/** Canned pairing replies. Pairing is never a health answer. */
const PAIRING_RESULT_TEXT: Record<PairingResult['kind'], string> = {
  paired: PAIRING_COMPLETE_TEXT,
  'already-paired': PAIRING_COMPLETE_TEXT,
  prompt: PAIRING_PROMPT_TEXT,
  invalid: PAIRING_INVALID_TEXT,
  expired: PAIRING_EXPIRED_TEXT,
  limited: PAIRING_LIMITED_TEXT,
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

/** Remove files left in the profile-agnostic media staging lane after a crash. */
export function sweepStagedMedia(stagingDir: string, stagingBaseDir?: string): void {
  try {
    const root = trustedDirectory(stagingDir, stagingBaseDir);
    if (!root) return;
    secureMkdir(root.lexical);
    const entries = fs.readdirSync(root.real);
    for (const entry of entries) {
      let candidate: string;
      try {
        candidate = resolveContainedPath(root.real, entry);
      } catch (error) {
        // A symlink is safe to unlink as a link, but never follow it.
        const raw = path.join(root.real, entry);
        try {
          if (fs.lstatSync(raw).isSymbolicLink()) fs.unlinkSync(raw);
        } catch (unlinkError) {
          console.warn('[gateway] Failed to sweep staged media entry:', summarizeErrorForLog(unlinkError));
        }
        if (!(error instanceof PathContainmentError)) {
          console.warn('[gateway] Failed to inspect staged media entry:', summarizeErrorForLog(error));
        }
        continue;
      }
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isFile() || stat.isSymbolicLink()) {
          fs.unlinkSync(candidate);
        }
      } catch (error) {
        console.warn('[gateway] Failed to sweep staged media entry:', summarizeErrorForLog(error));
      }
    }
  } catch (error) {
    console.warn('[gateway] Media staging sweep failed; continuing:', summarizeErrorForLog(error));
  }
}

export class GatewayMessageRouter {
  constructor(private readonly deps: GatewayMessageRouterDeps) {}

  async route(incoming: AdmittedMessage, egress: TurnEgress, logIncoming = true): Promise<string | undefined> {
    const { chatId, text } = incoming;
    if (logIncoming) {
      console.log(
        `[gateway] Message from ${chatId}: ${text.length} chars${incoming.mediaPath ? ', media attached' : ''}`,
      );
    }

    // S1 admission runs BEFORE anything else, including before the empty-message check, so a
    // request from a chat that is not the owner cannot consume a reply slot at all.
    const admission = this.deps.admission;
    const identity = transportIdentityOf(incoming);
    const decision = admission.inspect(identity);
    if (decision.kind === 'refused') {
      this.deleteStagedMedia(incoming.mediaPath);
      return this.emitSafely(
        egress,
        refusalTextFor(decision.reason),
        'Failed to send admission refusal',
      );
    }
    if (decision.kind === 'pairing-only') {
      return this.routePairing(incoming, egress, identity);
    }

    // Admission has now proved this chat IS the bound owner, so the selected owner identity is the
    // ONLY dispatch target this Router knows. There is no chat-to-identity lookup left to get wrong.
    const admittedOwnerId = this.deps.ownerId;

    // A REDELIVERED pairing event from the bound owner is still a pairing message, not a health
    // question: it must answer "pairing complete" instead of becoming a clinical turn.
    //
    // This is deliberately narrow. It used to test `isWellFormedSubmission(text)` — that is, "is this
    // eight characters from the pairing alphabet" — which also matched ordinary health words like
    // `headache`, `diabetes` and `insomnia`, answered "pairing complete", and dropped them without ever
    // answering or recording them. Only the event that actually established the binding qualifies.
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

    // Owner chat: the only path that may reach a clinical runtime. Admission has already proved this
    // chat is the bound owner, so the dispatch target is the owner identity — the sole value this
    // Router knows. There is no chat-to-identity lookup left to get wrong.
    const profileId = admittedOwnerId ?? this.deps.ownerId;
    // A chat that admission admitted is dispatched to the owner runtime. A chat it refused was already
    // answered above and never reaches this line.
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

  /**
   * An unpaired owner: pairing and emergency guidance only.
   *
   * Emergency text from a chat that is not yet bound stays canned, provider-free and
   * UNPERSISTED — there is no owner runtime to record it into, and writing it would recreate the
   * capture defect. Pairing text is never treated as clinical content.
   */
  private async routePairing(
    incoming: AdmittedMessage,
    egress: TurnEgress,
    identity: TransportIdentity,
  ): Promise<string> {
    this.deleteStagedMedia(incoming.mediaPath);

    const emergency = this.emergencyResponse(incoming.text);
    if (emergency) {
      return this.emitSafely(egress, emergency, 'Failed to send emergency response');
    }

    // A message that is not a well-formed code gets the generic prompt; it still consumes the
    // same daily allowance, so there is no free unlimited prompt channel.
    const result = await this.deps.admission.handlePairing(identity, incoming.text);
    return this.emitSafely(egress, PAIRING_RESULT_TEXT[result.kind], 'Failed to send pairing response');
  }

  private emergencyResponse(input: string): string | undefined {
    // RR2-A2 raw-input boundary: inspect `incoming.text` verbatim. Lines that look
    // like `User id:` / `Reply to message id:` / `Uploaded media path:` can be
    // user-authored (the router has not added trusted metadata yet), so they must
    // not be stripped here. Actual metadata fields (userId/mediaPath/reply) are
    // never concatenated into this input — see `buildAgentInput` callers.
    return isEmergencyInput(input, this.deps.config.emergency?.keywords)
      ? EMERGENCY_RESPONSE
      : undefined;
  }

  /**
   * M9 (closed). This used to append `User id: <transport sender id>` to the model input.
   *
   * The sender id is a chat-shaped identifier: it was being sent to the provider on every turn and
   * persisted in the session window, while being needed only for AUTHORIZATION — which admission has
   * already decided before this string exists. Nothing downstream reads it, so it bought nothing and cost
   * a re-identification channel into a third party. The authz decision still reads the full transport
   * identity; only the prompt payload changed.
   *
   * `mediaPath` and `replyToMessageId` stay: the first is how the owner refers to their own attachment,
   * and the second is thread structure, not identity.
   */
  private buildAgentInput(incoming: AdmittedMessage): string {
    const parts: string[] = [incoming.text];
    if (incoming.mediaPath) parts.push('', `Uploaded media path (relative to workspace): ${incoming.mediaPath}`);
    if (incoming.replyToMessageId) parts.push('', `Reply to message id: ${incoming.replyToMessageId}`);
    return parts.join('\n');
  }

  /**
   * RR-STRUCT R-S5b: resolve the runtime OWNING `profileId` for this turn — exactly once per
   * turn; every dispatch method below receives the result instead of re-resolving. Falls back
   * to the single injected `deps.runtime` when no resolver is present (direct Router unit
   * tests). A rejection (persistently-broken profile build, manager stopping) degrades to
   * `undefined` with a sanitized log — the caller emits the canned degraded reply, never throws.
   */
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
    // An emergency from an ADMITTED owner records into the owner runtime. An emergency from an
    // unadmitted chat never reaches here: `route()` refuses it at admission, before the emergency
    // detector runs, so it stays unpersisted canned guidance.
    //
    // OLD -> NEW: this used to fall back to `getExistingProfileForChat(chatId)`, i.e. it consulted the
    // registry to decide whether an emergency belonged to a profile. There is no registry and no
    // lookup: no admitted owner id means no runtime.
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

/**
 * Normalize an inbound message into the transport identity admission requires. A missing or
 * over-long field is carried through as-is so the admission service — not this adapter — decides it
 * is missing identity.
 */
export function transportIdentityOf(incoming: IncomingMessageLike): TransportIdentity {
  return {
    channel: incoming.channel ?? '',
    chatId: incoming.chatId,
    userId: incoming.userId,
    chatType: incoming.chatType ?? 'private',
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
