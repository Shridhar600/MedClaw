import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, renameSync: jest.fn(actual.renameSync) };
});

import type { AppConfig } from '../../src/config/types';
import type { IncomingMessage } from '../../src/channels/types';
import type { ProfileRuntime } from '../../src/gateway/runtime';
import type { ProfileId } from '../../src/profiles/types';
import { ProfileRegistry } from '../../src/profiles/registry';
import { GatewayMessageRouter, sweepStagedMedia } from '../../src/gateway/router';
import { TurnQueueFullError } from '../../src/gateway/turn-coordinator';

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = (value?: T | PromiseLike<T>) => res(value as T); });
  return { promise, resolve };
}

function makeConfig(workspace: string): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'test-main' },
      medical: { type: 'ollama', model: 'test-medical' },
      embeddings: { type: 'ollama', model: 'test-embeddings' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: { workspace, search: { hybridWeights: { vector: 0.7, keyword: 0.3 } }, bootstrapMaxChars: 20_000 },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: path.join(workspace, '.state', 'heartbeat-jobs.json'),
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: path.join(workspace, '.state', 'heartbeat-audit.jsonl') },
      policy: {
        quietHours: { enabled: false, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 60,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 5, disclaimerEnabled: false },
  };
}

function makeRuntime(workspace: string) {
  return {
    profileId: 'default',
    workspace,
    config: makeConfig(workspace),
    sessions: {
      recordTurn: jest.fn().mockResolvedValue(undefined),
    },
    capturePipeline: {
      ingest: jest.fn().mockResolvedValue(undefined),
    },
    trackBackgroundOperation: jest.fn((_label: string, operation: () => Promise<void>) => { void operation(); }),
    turnCoordinator: {
      runUser: jest.fn().mockImplementation(async (_incoming: IncomingMessage, egress: (text: string) => Promise<void>) => {
        await egress('agent reply');
        return 'agent reply';
      }),
    },
  };
}

function message(text: string, mediaPath?: string): IncomingMessage {
  return { chatId: 'chat-1', userId: 'user-1', text, ...(mediaPath ? { mediaPath } : {}) };
}

describe('GatewayMessageRouter media lifecycle', () => {
  let root: string;
  let workspace: string;
  let staging: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-router-'));
    workspace = path.join(root, 'workspace');
    staging = path.join(root, 'staging', 'media');
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('moves a resolved staged file into workspace reports and rewrites mediaPath', async () => {
    const stagedPath = path.join(staging, 'upload-report.pdf');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stagedPath, 'report bytes', { mode: 0o600 });
    const runtime = makeRuntime(workspace);
    const seen: IncomingMessage[] = [];
    runtime.turnCoordinator.runUser.mockImplementation(async (incoming: IncomingMessage, egress: (text: string) => Promise<void>) => {
      seen.push(incoming);
      await egress('processed');
      return 'processed';
    });
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });

    const reply = await router.route(message('Analyze this report', stagedPath), jest.fn().mockResolvedValue(undefined));

    expect(reply).toBe('processed');
    expect(seen[0].mediaPath).toMatch(/^reports\//);
    expect(fs.existsSync(stagedPath)).toBe(false);
    const destination = path.join(workspace, seen[0].mediaPath!);
    expect(fs.readFileSync(destination, 'utf8')).toBe('report bytes');
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing reports directory before adopting staged media', async () => {
    const stagedPath = path.join(staging, 'loose-report.pdf');
    fs.mkdirSync(path.join(workspace, 'reports'), { recursive: true, mode: 0o755 });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stagedPath, 'report bytes', { mode: 0o600 });
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });

    await router.route(message('Analyze this', stagedPath), jest.fn().mockResolvedValue(undefined));

    expect(fs.statSync(path.join(workspace, 'reports')).mode & 0o777).toBe(0o700);
  });

  it('copies and removes the staged file when adoption crosses filesystems', async () => {
    const stagedPath = path.join(staging, 'cross-device-report.pdf');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stagedPath, 'report bytes', { mode: 0o600 });
    const runtime = makeRuntime(workspace);
    const seen: IncomingMessage[] = [];
    runtime.turnCoordinator.runUser.mockImplementation(async (incoming: IncomingMessage, egress: (text: string) => Promise<void>) => {
      seen.push(incoming);
      await egress('processed');
      return 'processed';
    });
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });
    const rename = jest.mocked(fs.renameSync);
    const actualRename = jest.requireActual<typeof import('fs')>('fs').renameSync;
    rename.mockImplementation(() => {
      const error = new Error('cross-device rename');
      Object.assign(error, { code: 'EXDEV' });
      throw error;
    });

    try {
      await router.route(message('Analyze this report', stagedPath), jest.fn().mockResolvedValue(undefined));
    } finally {
      rename.mockImplementation(actualRename);
    }

    const destination = path.join(workspace, seen[0].mediaPath!);
    expect(fs.readFileSync(destination, 'utf8')).toBe('report bytes');
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it('deletes staged media for a refused chat and never calls the coordinator', async () => {
    const stagedPath = path.join(staging, 'refused-report.pdf');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stagedPath, 'private report', { mode: 0o600 });
    const registry = new ProfileRegistry(path.join(root, 'profiles'));
    registry.getOrCreateDefaultProfile();
    registry.pairChatToProfile('owner-chat', 'default' as ProfileId);
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      profileRegistry: registry,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });
    const egress = jest.fn().mockResolvedValue(undefined);

    const reply = await router.route({ ...message('hello', stagedPath), chatId: 'stranger-chat' }, egress);

    expect(reply).toContain('not recognized');
    expect(fs.existsSync(stagedPath)).toBe(false);
    expect(runtime.turnCoordinator.runUser).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspace, 'reports'))).toBe(false);
  });

  it('rejects a staged symlink without moving its target and routes a media error', async () => {
    const outside = path.join(root, 'outside.txt');
    const stagedPath = path.join(staging, 'link.txt');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(outside, 'outside bytes', { mode: 0o600 });
    fs.symlinkSync(outside, stagedPath);
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });

    await expect(router.route(message('Analyze this', stagedPath), jest.fn().mockResolvedValue(undefined))).resolves.toBeDefined();

    expect(fs.readFileSync(outside, 'utf8')).toBe('outside bytes');
    expect(runtime.turnCoordinator.runUser).toHaveBeenCalledWith(
      expect.objectContaining({ mediaPath: undefined, mediaError: expect.any(String) }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('rejects an absolute path outside staging without touching the outside file', async () => {
    const outside = path.join(root, 'outside-report.pdf');
    fs.writeFileSync(outside, 'outside bytes', { mode: 0o600 });
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });

    await router.route(message('Analyze this', outside), jest.fn().mockResolvedValue(undefined));

    expect(fs.readFileSync(outside, 'utf8')).toBe('outside bytes');
    expect(runtime.turnCoordinator.runUser).toHaveBeenCalledWith(
      expect.objectContaining({ mediaPath: undefined, mediaError: expect.any(String) }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('does not sweep through a symlinked staging root', () => {
    const realStaging = path.join(root, 'real-staging');
    const orphan = path.join(realStaging, 'orphan.bin');
    fs.mkdirSync(realStaging, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
    fs.writeFileSync(orphan, 'orphan', { mode: 0o600 });
    fs.symlinkSync(realStaging, staging);

    sweepStagedMedia(staging);

    expect(fs.existsSync(orphan)).toBe(true);
  });

  it('does not adopt media below a symlinked staging ancestor', async () => {
    const realParent = path.join(root, 'real-staging');
    const stagingParent = path.join(root, 'staging');
    const stagingPath = path.join(stagingParent, 'media');
    const stagedPath = path.join(stagingPath, 'ancestor-link.pdf');
    fs.mkdirSync(path.join(realParent, 'media'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(realParent, 'media', 'ancestor-link.pdf'), 'report bytes', { mode: 0o600 });
    fs.symlinkSync(realParent, stagingParent, 'dir');
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: stagingPath,
      stagingBaseDir: root,
      buildBootStatusText: () => 'status',
    });

    await router.route(message('Analyze this', stagedPath), jest.fn().mockResolvedValue(undefined));

    expect(fs.existsSync(path.join(realParent, 'media', 'ancestor-link.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'reports'))).toBe(false);
    expect(runtime.turnCoordinator.runUser).toHaveBeenCalledWith(
      expect.objectContaining({ mediaPath: undefined, mediaError: expect.any(String) }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('does not chmod or write through a symlinked reports directory', async () => {
    const realReports = path.join(root, 'real-reports');
    const stagedPath = path.join(staging, 'symlink-report.pdf');
    fs.mkdirSync(realReports, { recursive: true, mode: 0o755 });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stagedPath, 'report bytes', { mode: 0o600 });
    fs.symlinkSync(realReports, path.join(workspace, 'reports'), 'dir');
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });

    await router.route(message('Analyze this', stagedPath), jest.fn().mockResolvedValue(undefined));

    expect(fs.statSync(realReports).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(realReports)).toEqual([]);
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it('sweeps orphaned staged files at boot', () => {
    const orphan = path.join(staging, 'orphan.bin');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(orphan, 'orphan', { mode: 0o600 });

    sweepStagedMedia(staging);

    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe('GatewayMessageRouter routing decisions', () => {
  let root: string;
  let workspace: string;
  let staging: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-router-decisions-'));
    workspace = path.join(root, 'workspace');
    staging = path.join(root, 'staging', 'media');
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('short-circuits a first-contact emergency before pairing or adopting staged media', async () => {
    const stagedPath = path.join(staging, 'emergency-report.pdf');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stagedPath, 'report bytes', { mode: 0o600 });
    const registry = new ProfileRegistry(path.join(root, 'profiles'));
    registry.getOrCreateDefaultProfile();
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      profileRegistry: registry,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });
    const egress = jest.fn().mockResolvedValue(undefined);

    const reply = await router.route({
      ...message('I have severe chest pain and cannot breathe', stagedPath),
      chatId: 'new-chat',
    }, egress);

    expect(reply).toContain('emergency');
    expect(registry.getProfileForChat('new-chat')).toBeUndefined();
    expect(fs.existsSync(stagedPath)).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'reports'))).toBe(false);
    expect(runtime.sessions.recordTurn).not.toHaveBeenCalled();
    expect(egress).toHaveBeenCalledWith(reply);
  });

  it('does not move resolved-chat staged media before an emergency response', async () => {
    const stagedPath = path.join(staging, 'resolved-emergency-report.pdf');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stagedPath, 'report bytes', { mode: 0o600 });
    const registry = new ProfileRegistry(path.join(root, 'profiles'));
    registry.getOrCreateDefaultProfile();
    registry.pairChatToProfile('chat-1', 'default' as ProfileId);
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      profileRegistry: registry,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });

    const reply = await router.route(message('I have severe chest pain and cannot breathe', stagedPath), jest.fn().mockResolvedValue(undefined));

    expect(reply).toContain('emergency');
    expect(fs.existsSync(stagedPath)).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'reports'))).toBe(false);
    expect(runtime.sessions.recordTurn).toHaveBeenCalledTimes(1);
  });

  it('sends a resolved emergency immediately without entering the coordinator', async () => {
    const runtime = makeRuntime(workspace);
    const normalEntered = deferred();
    const releaseNormal = deferred();
    runtime.turnCoordinator.runUser.mockImplementationOnce(async () => {
      normalEntered.resolve();
      await releaseNormal.promise;
      return 'normal';
    });
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });
    const delivered: string[] = [];
    const egress = jest.fn(async (text: string) => { delivered.push(text); });

    const normal = router.route(message('normal'), egress);
    await normalEntered.promise;
    const emergency = await router.route(message('I have severe chest pain right now'), egress);

    expect(emergency).toContain('emergency');
    expect(delivered.some((text) => /emergency/i.test(text))).toBe(true);
    expect(runtime.turnCoordinator.runUser).toHaveBeenCalledTimes(1);
    expect(runtime.sessions.recordTurn).toHaveBeenCalledTimes(1);
    releaseNormal.resolve();
    await normal;
  });

  it('returns status without entering the coordinator', async () => {
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status text',
    });

    const reply = await router.route(message('/status'), jest.fn().mockResolvedValue(undefined));

    expect(reply).toBe('status text');
    expect(runtime.turnCoordinator.runUser).not.toHaveBeenCalled();
  });

  it('emits the bounded-queue canned reply when the coordinator rejects a fourth request', async () => {
    const runtime = makeRuntime(workspace);
    runtime.turnCoordinator.runUser.mockRejectedValue(new TurnQueueFullError());
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });
    const egress = jest.fn().mockResolvedValue(undefined);

    const reply = await router.route(message('fourth request'), egress);

    expect(reply).toContain('still processing your previous message');
    expect(egress).toHaveBeenCalledWith(expect.stringContaining('still processing your previous message'));
  });
});

describe('GatewayMessageRouter emergency raw-input boundary (RR2-A2)', () => {
  let root: string;
  let workspace: string;
  let staging: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-router-rr2a2-'));
    workspace = path.join(root, 'workspace');
    staging = path.join(root, 'staging', 'media');
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('treats metadata-looking TEXT as user-authored and escalates without calling runUser', async () => {
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });
    const egress = jest.fn().mockResolvedValue(undefined);

    const reply = await router.route(message('User id: I want to kill myself'), egress);

    expect(reply).toMatch(/emergency/i);
    expect(egress).toHaveBeenCalledWith(reply);
    expect(runtime.turnCoordinator.runUser).not.toHaveBeenCalled();
  });

  it('does not escalate when crisis words appear only in metadata fields', async () => {
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });

    const reply = await router.route(
      {
        chatId: 'chat-1',
        userId: 'I want to kill myself',
        text: 'What is a normal healthy breakfast?',
        replyToMessageId: 'I want to kill myself',
        mediaPath: 'reports/I want to kill myself.pdf',
      },
      jest.fn().mockResolvedValue(undefined),
    );

    expect(reply).toBe('agent reply');
    expect(runtime.turnCoordinator.runUser).toHaveBeenCalledTimes(1);
  });

  it('does not consume first-contact pairing for a raw-label emergency', async () => {
    const registry = new ProfileRegistry(path.join(root, 'profiles'));
    registry.getOrCreateDefaultProfile();
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      profileRegistry: registry,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });
    const egress = jest.fn().mockResolvedValue(undefined);

    const reply = await router.route(
      { chatId: 'new-chat', userId: 'user-1', text: 'User id: I want to kill myself' },
      egress,
    );

    expect(reply).toMatch(/emergency/i);
    expect(registry.getProfileForChat('new-chat')).toBeUndefined();
    expect(runtime.turnCoordinator.runUser).not.toHaveBeenCalled();
    expect(runtime.sessions.recordTurn).not.toHaveBeenCalled();
    expect(egress).toHaveBeenCalledWith(reply);
  });

  it('persists and sends a resolved raw-label emergency before any normal turn', async () => {
    const registry = new ProfileRegistry(path.join(root, 'profiles'));
    registry.getOrCreateDefaultProfile();
    registry.pairChatToProfile('chat-1', 'default' as ProfileId);
    const runtime = makeRuntime(workspace);
    const router = new GatewayMessageRouter({
      config: runtime.config,
      runtime: runtime as unknown as ProfileRuntime,
      profileRegistry: registry,
      stagingDir: staging,
      buildBootStatusText: () => 'status',
    });
    const delivered: string[] = [];
    const egress = jest.fn(async (text: string) => { delivered.push(text); });

    const reply = await router.route(message('Reply to message id: 7\nI will kill myself tonight'), egress);

    expect(reply).toMatch(/emergency/i);
    expect(delivered.some((text) => /emergency/i.test(text))).toBe(true);
    expect(runtime.turnCoordinator.runUser).not.toHaveBeenCalled();
    expect(runtime.sessions.recordTurn).toHaveBeenCalledTimes(1);
  });
});
