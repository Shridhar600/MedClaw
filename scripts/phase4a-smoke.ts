import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli } from '../src/cli/index';
import { loadConfig, saveConfig, getDefaultConfig } from '../src/config/config';
import { Gateway } from '../src/gateway/gateway';

type SmokeMode =
  | 'init-noninteractive'
  | 'daemon-missing-config'
  | 'first-chat-onboarding'
  | 'admin-status'
  | 'profile-complete'
  | 'init-interactive-scripted'
  | 'status-unreachable'
  | 'openai-missing-key'
  | 'corrupt-onboarding';

function tempRoot(mode: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `redacted-phase4a-${mode}-`));
}

async function initNoninteractive(): Promise<void> {
  const root = tempRoot('init-');
  const configPath = path.join(root, 'config.json');
  const workspacePath = path.join(root, 'workspace');
  const out: string[] = [];
  const code = await runCli(
    [
      'init',
      '--yes',
      '--config', configPath,
      '--workspace', workspacePath,
      '--provider', 'ollama',
      '--telegram-enabled', 'false',
      '--timezone', 'Asia/Kolkata',
      '--heartbeats-enabled', 'true',
    ],
    {
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      input: async () => {
        throw new Error('non-interactive init attempted to prompt');
      },
    },
  );
  if (code !== 0) {
    throw new Error(out.join(''));
  }
  for (const required of ['SOUL.md', 'USER.md', 'HEALTH_PROFILE.md', 'HEARTBEAT.md']) {
    assertExists(path.join(workspacePath, required));
  }
  for (const required of ['conditions', 'medications', 'reports', 'goals', 'memory']) {
    assertExists(path.join(workspacePath, required));
  }
  assertExists(path.join(root, 'sessions'));
  assertExists(path.join(root, 'heartbeats'));
  console.log(JSON.stringify({ mode: 'init-noninteractive', root, configPath, workspacePath }, null, 2));
}

async function daemonMissingConfig(): Promise<void> {
  const root = tempRoot('daemon-');
  const configPath = path.join(root, 'missing-config.json');
  const result = spawnSync('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, REDACTED_CONFIG_PATH: configPath },
    encoding: 'utf8',
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !combined.includes('npm run cli -- init')) {
    throw new Error(`daemon missing-config guard failed:\n${combined}`);
  }
  console.log(JSON.stringify({ mode: 'daemon-missing-config', root, configPath, exitCode: result.status }, null, 2));
}

async function firstChatOnboarding(): Promise<void> {
  const { root, config, gateway, run } = await makeTestGateway('first-chat-');
  const first = await gateway.handleTestMessage('chat-1', 'hello');
  if (!first.includes('Before we start')) {
    throw new Error(`expected onboarding prompt, got: ${first}`);
  }
  for (const input of [
    'Shridhar',
    '31',
    'Asia/Kolkata',
    'Type 2 diabetes',
    'Metformin',
    'Penicillin',
    'Improve glucose control',
    'Morning reminders',
    'confirm',
  ]) {
    await gateway.handleTestMessage('chat-1', input);
  }
  const normal = await gateway.handleTestMessage('chat-1', 'Can I eat daal chawal?');
  if (normal !== 'normal-agent-path') {
    throw new Error(`normal agent path was not reached: ${normal}`);
  }
  if (run.calls.length !== 1) {
    throw new Error(`expected exactly one agent call after onboarding, saw ${run.calls.length}`);
  }
  console.log(JSON.stringify({ mode: 'first-chat-onboarding', root, workspace: config.memory.workspace }, null, 2));
}

async function adminStatus(): Promise<void> {
  const root = tempRoot('admin-');
  const configPath = path.join(root, 'config.json');
  const workspacePath = path.join(root, 'workspace');
  const initOutput: string[] = [];
  const initCode = await runCli(
    [
      'init',
      '--yes',
      '--config', configPath,
      '--workspace', workspacePath,
      '--provider', 'ollama',
      '--telegram-enabled', 'false',
      '--timezone', 'Asia/Kolkata',
      '--heartbeats-enabled', 'true',
    ],
    { stdout: (text) => initOutput.push(text), stderr: (text) => initOutput.push(text) },
  );
  if (initCode !== 0) {
    throw new Error(initOutput.join(''));
  }
  const output: string[] = [];
  const statusCode = await runCli(['--config', configPath, 'status'], {
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  const text = output.join('');
  if (statusCode !== 0 || !text.includes('workspace:') || text.includes('secret')) {
    throw new Error(`admin status failed:\n${text}`);
  }
  console.log(JSON.stringify({ mode: 'admin-status', root, configPath, status: text.trim() }, null, 2));
}

async function profileComplete(): Promise<void> {
  const { root, config, gateway } = await makeTestGateway('profile-');
  for (const input of [
    'hello',
    'Shridhar',
    '31',
    'Asia/Kolkata',
    'Type 2 diabetes',
    'Metformin',
    'Penicillin',
    'Improve glucose control',
    'Morning reminders',
    'confirm',
  ]) {
    await gateway.handleTestMessage('chat-1', input);
  }
  const user = fs.readFileSync(path.join(config.memory.workspace, 'USER.md'), 'utf8');
  const profile = fs.readFileSync(path.join(config.memory.workspace, 'HEALTH_PROFILE.md'), 'utf8');
  if (!user.includes('Name: Shridhar') || !profile.includes('Active conditions: Type 2 diabetes')) {
    throw new Error('profile files did not include completed onboarding data');
  }
  console.log(JSON.stringify({ mode: 'profile-complete', root, workspace: config.memory.workspace }, null, 2));
}

async function initInteractiveScripted(): Promise<void> {
  const root = tempRoot('interactive-');
  const configPath = path.join(root, 'config.json');
  const workspacePath = path.join(root, 'workspace');
  const input = [
    workspacePath,
    'ollama',
    'llama3.1',
    'amsaravi/medgemma-4b-it:q8',
    'nomic-embed-text',
    'http://localhost:11434/v1',
    'n',
    'Asia/Kolkata',
    'y',
    '',
  ].join('\n');
  const result = spawnSync('npx', ['tsx', 'src/cli/index.ts', 'init', '--config', configPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOME: root },
    input,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !fs.existsSync(configPath)) {
    throw new Error(`interactive init failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  const config = await loadConfig({ configPath, requireFile: true });
  if (config.channels.telegram.enabled || config.memory.workspace !== workspacePath) {
    throw new Error('interactive answers were not applied to config');
  }
  console.log(JSON.stringify({ mode: 'init-interactive-scripted', root, configPath, workspacePath }, null, 2));
}

async function statusUnreachable(): Promise<void> {
  const root = tempRoot('status-unreachable-');
  const configPath = path.join(root, 'config.json');
  const config = getDefaultConfig();
  config.channels.telegram.enabled = false;
  config.memory.workspace = path.join(root, 'workspace');
  config.providers.main.baseUrl = 'http://127.0.0.1:1/v1';
  config.providers.medical.baseUrl = 'http://127.0.0.1:1/v1';
  config.providers.embeddings.baseUrl = 'http://127.0.0.1:1/v1';
  config.heartbeat.storePath = path.join(root, 'heartbeats', 'jobs.json');
  await saveConfig(configPath, config);
  const output: string[] = [];
  const code = await runCli(['--config', configPath, 'status'], {
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  const text = output.join('');
  if (code !== 0 || text.includes('main provider: ready') || !text.includes('configured (not checked)')) {
    throw new Error(`unexpected status output:\n${text}`);
  }
  console.log(JSON.stringify({ mode: 'status-unreachable', root, status: text.trim() }, null, 2));
}

async function openaiMissingKey(): Promise<void> {
  const root = tempRoot('openai-missing-key-');
  const configPath = path.join(root, 'config.json');
  const output: string[] = [];
  const prior = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const code = await runCli(
      [
        'init',
        '--yes',
        '--config', configPath,
        '--workspace', path.join(root, 'workspace'),
        '--provider', 'openai',
        '--telegram-enabled', 'false',
        '--heartbeats-enabled', 'false',
      ],
      { stdout: (text) => output.push(text), stderr: (text) => output.push(text) },
    );
    const text = output.join('');
    if (code === 0 || !text.includes('OPENAI_API_KEY') || fs.existsSync(configPath)) {
      throw new Error(`OpenAI missing-key smoke failed:\n${text}`);
    }
    console.log(JSON.stringify({ mode: 'openai-missing-key', root, output: text.trim() }, null, 2));
  } finally {
    if (prior === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prior;
    }
  }
}

async function corruptOnboarding(): Promise<void> {
  const { root, config, gateway, run } = await makeTestGateway('corrupt-onboarding-');
  const stateDir = path.join(config.memory.workspace, '.redacted');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'onboarding.json'), '{bad-json', 'utf8');
  const response = await gateway.handleTestMessage('chat-1', 'hello');
  const quarantined = fs.readdirSync(stateDir).find((name) => name.startsWith('onboarding.json.corrupt-'));
  if (!response.includes('Before we start') || !quarantined || run.calls.length !== 0) {
    throw new Error('corrupt onboarding state did not recover to first prompt');
  }
  console.log(JSON.stringify({ mode: 'corrupt-onboarding', root, workspace: config.memory.workspace, quarantined }, null, 2));
}

async function makeTestGateway(prefix: string): Promise<{
  root: string;
  config: ReturnType<typeof getDefaultConfig>;
  gateway: Gateway;
  run: MockAgentRun;
}> {
  const root = tempRoot(prefix);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'USER.md'), '# User Preferences\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'HEALTH_PROFILE.md'), '# Health Profile\n', 'utf8');
  const config = getDefaultConfig();
  config.memory.workspace = workspace;
  config.channels.telegram.enabled = false;
  config.heartbeat.enabled = false;
  config.heartbeat.storePath = path.join(root, 'heartbeats', 'jobs.json');
  config.heartbeat.audit.path = path.join(root, 'heartbeats', 'audit.jsonl');
  await saveConfig(path.join(root, 'config.json'), config);
  const loaded = await loadConfig({ configPath: path.join(root, 'config.json'), requireFile: true });
  const gateway = new Gateway(loaded);
  const run = createMockRun();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).agentLoop = { run };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).sessions = {
    prepareHistory: async () => [],
    recordTurn: async () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).reconcileHeartbeatPolicies = async () => undefined;
  return { root, config: loaded, gateway, run };
}

interface MockAgentRun {
  (...args: unknown[]): Promise<{
    text: string;
    trace: Array<{ role: 'assistant'; content: string }>;
    usedTools: unknown[];
    healthResponse: boolean;
  }>;
  calls: unknown[][];
}

function createMockRun(): MockAgentRun {
  const fn = ((...args: unknown[]) => {
    fn.calls.push(args);
    return Promise.resolve({
      text: 'normal-agent-path',
      trace: [{ role: 'assistant', content: 'normal-agent-path' }],
      usedTools: [],
      healthResponse: false,
    });
  }) as MockAgentRun;
  fn.calls = [];
  return fn;
}

function assertExists(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`expected path to exist: ${filePath}`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] as SmokeMode | undefined;
  switch (mode) {
    case 'init-noninteractive':
      await initNoninteractive();
      break;
    case 'daemon-missing-config':
      await daemonMissingConfig();
      break;
    case 'first-chat-onboarding':
      await firstChatOnboarding();
      break;
    case 'admin-status':
      await adminStatus();
      break;
    case 'profile-complete':
      await profileComplete();
      break;
    case 'init-interactive-scripted':
      await initInteractiveScripted();
      break;
    case 'status-unreachable':
      await statusUnreachable();
      break;
    case 'openai-missing-key':
      await openaiMissingKey();
      break;
    case 'corrupt-onboarding':
      await corruptOnboarding();
      break;
    default:
      throw new Error('Usage: npx tsx scripts/phase4a-smoke.ts <init-noninteractive|daemon-missing-config|first-chat-onboarding|admin-status|profile-complete|init-interactive-scripted|status-unreachable|openai-missing-key|corrupt-onboarding>');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
