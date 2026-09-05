import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from '../config/types';
import type { IncomingMessage } from '../channels/types';
import { ProfileRegistry, type ProfileId } from '../profiles';
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
  config: AppConfig;
  runtime?: ProfileRuntime;
  profileRegistry?: ProfileRegistry;
  stagingDir: string;
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
}

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

  async route(incoming: IncomingMessage, egress: TurnEgress, logIncoming = true): Promise<string | undefined> {
    const { chatId, text } = incoming;
    if (logIncoming) {
      console.log(
        `[gateway] Message from ${chatId}: ${text.length} chars${incoming.mediaPath ? ', media attached' : ''}`,
      );
    }

    if (text.trim().length === 0 && !incoming.mediaPath && !incoming.mediaError) {
      return this.emitSafely(egress, EMPTY_MESSAGE_RESPONSE, 'Failed to send empty-message response');
    }

    const emergency = this.emergencyResponse(text);
    if (emergency) {
      return this.routeEmergency(incoming, egress, emergency);
    }

    const profileId = this.getProfileForChat(chatId);
    if (profileId === null) {
      this.deleteStagedMedia(incoming.mediaPath);
      return this.emitSafely(
        egress,
        UNRECOGNIZED_CHAT_RESPONSE,
        'Failed to respond to unrecognized chat',
      );
    }
    // RR-STRUCT R-S5b: the RR-4 interim refusal (`!isDefaultRuntimeProfile`) is RETIRED — a
    // paired non-default chat is dispatched to its OWN runtime below. The `profileId === null`
    // refusal above is untouched: an unpaired chat can never reach the resolved-runtime path.
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

  resolveProfileForChat(chatId: string): ProfileId | null {
    return this.getProfileForChat(chatId);
  }

  isDefaultProfile(profileId: ProfileId): boolean {
    return this.isDefaultRuntimeProfile(profileId);
  }

  private getProfileForChat(chatId: string): ProfileId | null {
    const registry = this.deps.profileRegistry;
    if (!registry) {
      return (this.deps.config.profiles?.defaultProfileId ?? 'default') as ProfileId;
    }
    const existing = registry.getProfileForChat(chatId);
    if (existing) return existing.profileId;

    const anyChatPaired = registry.getAllProfiles().some((profile) => profile.chatIds.length > 0);
    if (anyChatPaired) {
      console.warn(`[gateway] Refused unrecognized chat ${chatId} (auto-pair closed after first pairing)`);
      return null;
    }

    const defaultProfile = registry.getOrCreateDefaultProfile();
    registry.pairChatToProfile(chatId, defaultProfile.profileId);
    console.log(`[gateway] Paired chat ${chatId} to profile "${defaultProfile.profileId}" (first-contact auto-pair)`);
    return defaultProfile.profileId;
  }

  private getExistingProfileForChat(chatId: string): ProfileId | null {
    const registry = this.deps.profileRegistry;
    if (!registry) {
      return (this.deps.config.profiles?.defaultProfileId ?? 'default') as ProfileId;
    }
    return registry.getProfileForChat(chatId)?.profileId ?? null;
  }

  private isDefaultRuntimeProfile(profileId: ProfileId): boolean {
    return profileId === (this.deps.config.profiles?.defaultProfileId ?? 'default');
  }

  private emergencyResponse(input: string): string | undefined {
    const cleanInput = input
      .split(/\r?\n/)
      .filter((line) => !/^\s*(user id|reply to message id|uploaded media path)\s*:/i.test(line))
      .join('\n');
    return isEmergencyInput(cleanInput, this.deps.config.emergency?.keywords)
      ? EMERGENCY_RESPONSE
      : undefined;
  }

  private buildAgentInput(incoming: IncomingMessage): string {
    const parts: string[] = [incoming.text];
    if (incoming.mediaPath) parts.push('', `Uploaded media path (relative to workspace): ${incoming.mediaPath}`);
    if (incoming.replyToMessageId) parts.push('', `Reply to message id: ${incoming.replyToMessageId}`);
    if (incoming.userId) parts.push('', `User id: ${incoming.userId}`);
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
    incoming: IncomingMessage,
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

  private async routeEmergency(incoming: IncomingMessage, egress: TurnEgress, emergency: string): Promise<string> {
    // NOTE: deliberately `getExistingProfileForChat` (no auto-pair) — an emergency from an
    // unknown chat must NEVER consume the one-time first-contact pairing, and stays
    // unpersisted guidance. Only a chat already paired to a profile resolves a runtime.
    const profileId = this.getExistingProfileForChat(incoming.chatId);
    const runtime = profileId !== null ? await this.resolveRuntimeFor(profileId) : undefined;
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

  private scheduleBackgroundCapture(incoming: IncomingMessage, runtime: ProfileRuntime): void {
    scheduleBackgroundCapture(runtime, incoming);
  }

  private adoptStagedMedia(incoming: IncomingMessage, runtime: ProfileRuntime): void {
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

function trustedDirectory(directory: string, trustedBaseDir?: string): TrustedDirectory | undefined {
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
