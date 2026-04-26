import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDefaultConfig } from '../../src/config/config';
import { preflightStartCheck, verifyTelegramRuntime } from '../../src/cli/setup-readiness';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('setup readiness', () => {
  let tmpDir: string;
  let configPath: string;
  let workspacePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-setup-readiness-'));
    configPath = path.join(tmpDir, 'config.json');
    workspacePath = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(configPath, '{}\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks startup when required Ollama models are missing', async () => {
    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = true;

    const report = await preflightStartCheck(config, configPath, {
      fetchImpl: jest.fn(async (url: string | URL) => {
        const target = String(url);
        if (target.endsWith('/api/version')) {
          return jsonResponse({ version: '0.6.0' });
        }
        if (target.endsWith('/api/tags')) {
          return jsonResponse({
            models: [{ name: config.providers.main.model }],
          });
        }
        throw new Error(`Unexpected URL: ${target}`);
      }) as typeof fetch,
      timeoutMs: 50,
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`Missing Ollama model: ${config.providers.medical.model}`),
        expect.stringContaining(`Missing Ollama model: ${config.providers.embeddings.model}`),
      ]),
    );
  });

  it('blocks invalid Telegram tokens during runtime verification', async () => {
    const config = getDefaultConfig();
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = '123456:bad-token';

    const result = await verifyTelegramRuntime(config, {
      fetchImpl: jest.fn(async () =>
        jsonResponse({ ok: false, description: 'Unauthorized' }, 401),
      ) as typeof fetch,
      timeoutMs: 50,
    });

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual(['Unauthorized']);
  });

  it('blocks startup when no runtime channel or heartbeat is enabled', async () => {
    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = false;

    const report = await preflightStartCheck(config, configPath);

    expect(report.ready).toBe(false);
    expect(report.blockers).toContain(
      'Nothing is enabled to keep MedClaw running. Enable Telegram or heartbeats before starting.',
    );
  });
});
