// tests/config/config.test.ts
//
// T1 assertion migration. Retired assertions and the stronger contract that replaces each
// one are recorded inline as `RETIRED -> ...` so the mapping stays auditable.
//
// The flow under test is the real one: a document on disk is read through the bounded
// adapter, decoded by the same decoder the daemon uses, and the owner paths are derived.
// Nothing here asserts only a string shape.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDefaultConfig, decodeConfigDocument } from '../../src/config';
import { redactConfig, validateConfig } from '../../src/config/validation';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { readConfigDocument, effectiveConfigFor, writeConfigDocument } from '../../src/runtime/installation';
import { toStoredView } from '../../src/config/validation';
import { writeConfigFixture, storedConfigFor } from '../helpers/config-fixture';

function decode(raw: unknown, homeDir: string) {
  return decodeConfigDocument(raw, { homeDir });
}

function validDoc(homeDir: string, apply?: (doc: Record<string, unknown>) => void): Record<string, unknown> {
  const doc = structuredClone(storedConfigFor(path.join(homeDir, 'state'), 'owner')) as unknown as Record<string, unknown>;
  apply?.(doc);
  return doc;
}

function issueCodes(result: ReturnType<typeof decodeConfigDocument>): string[] {
  return result.kind === 'invalid' ? result.issues.map((issue) => issue.code) : [];
}

function issueFields(result: ReturnType<typeof decodeConfigDocument>): string[] {
  return result.kind === 'invalid' ? result.issues.map((issue) => issue.field) : [];
}

describe('stored config decoding', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns isolated default config copies', () => {
    const first = getDefaultConfig();
    first.providers.main.model = 'mutated-model';

    const second = getDefaultConfig();
    expect(second.providers.main.model).toBe('kimi-k2.5:cloud');
  });

  it('fills omitted non-identity defaults only after validating the supplied shape', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      (doc.providers as Record<string, unknown>).main = { type: 'openai', model: 'gpt-4o', apiKey: 'sk-test' };
    }), tmpDir);

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.config.providers.main.type).toBe('openai');
    expect(result.config.providers.main.model).toBe('gpt-4o');
    expect(result.config.agent.maxIterations).toBe(15);
  });

  it('retains built-in emergency keywords and adds validated configured ones without duplicates', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      doc.emergency = { keywords: ['code violet', 'chest pain'] };
    }), tmpDir);

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    const keywords = result.config.emergency?.keywords ?? [];
    expect(keywords).toEqual(expect.arrayContaining(['want to die', 'code violet']));
    expect(keywords.filter((k) => k === 'chest pain')).toHaveLength(1);
  });

  it('refuses an empty configured emergency keyword instead of storing a match-nothing term', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      doc.emergency = { keywords: [''] };
    }), tmpDir);

    expect(issueCodes(result)).toContain('out-of-range');
    expect(issueFields(result)).toContain('emergency.keywords[0]');
  });

  it('refuses a document that carries no owner identity', () => {
    const doc = validDoc(tmpDir);
    delete doc.profiles;

    const result = decode(doc, tmpDir);

    expect(result.kind).toBe('invalid');
    expect(issueFields(result)).toEqual(expect.arrayContaining(['profiles.baseDir', 'profiles.defaultProfileId']));
    expect(issueCodes(result)).toContain('missing-field');
  });

  it('refuses a pre-schemaVersion-2 document rather than interpreting it', () => {
    const result = decode(validDoc(tmpDir, (doc) => { doc.schemaVersion = 1; }), tmpDir);

    expect(issueCodes(result)).toContain('invalid-schema-version');
  });

  // RETIRED -> the three derived path keys are no longer persisted authority. Each is now
  // refused with setup guidance instead of being merged, migrated or silently ignored.
  it.each([
    ['memory.workspace', (doc: Record<string, unknown>) => { (doc.memory as Record<string, unknown>).workspace = '/tmp/x'; }],
    ['heartbeat.storePath', (doc: Record<string, unknown>) => { (doc.heartbeat as Record<string, unknown>).storePath = '/tmp/x.json'; }],
    ['heartbeat.audit', (doc: Record<string, unknown>) => { (doc.heartbeat as Record<string, unknown>).audit = { path: '/tmp/x.jsonl' }; }],
  ])('refuses the retired path authority %s', (field, apply) => {
    const result = decode(validDoc(tmpDir, apply), tmpDir);

    expect(issueCodes(result)).toContain('retired-field');
    expect(issueFields(result)).toContain(field);
  });

  it('refuses an unknown key instead of merging and re-persisting it', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      (doc.heartbeat as Record<string, unknown>).storepath = '/tmp/typo';
    }), tmpDir);

    expect(issueCodes(result)).toContain('unknown-field');
    expect(issueFields(result)).toContain('heartbeat.storepath');
  });

  it('refuses a prototype key', () => {
    const raw = JSON.parse('{"schemaVersion":2,"profiles":{"baseDir":"/tmp/s","defaultProfileId":"owner"},"agent":{"maxIterations":5},"__proto__":{"injected":true}}');
    const result = decode(raw, tmpDir);

    expect(issueCodes(result)).toContain('prototype-field');
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
  });

  // RETIRED -> `heartbeat.audit = null` used to reach a non-null assertion and crash the
  // loader with `TypeError: Cannot read properties of null`. The key is refused first, and a
  // non-retired malformed branch is refused by type instead.
  it('refuses the malformed heartbeat branch that used to crash the loader with a TypeError', () => {
    const retired = decode(validDoc(tmpDir, (doc) => { doc.heartbeat = { audit: null }; }), tmpDir);

    expect(issueCodes(retired)).toContain('retired-field');

    const malformed = decode(validDoc(tmpDir, (doc) => { doc.memory = { search: null }; }), tmpDir);
    expect(issueCodes(malformed)).toContain('wrong-type');
    expect(issueFields(malformed)).toContain('memory.search');
  });

  it.each([
    ['agent.maxIterations', 0, 'out-of-range'],
    ['heartbeat.timezone', 'Not/AZone', 'invalid-timezone'],
    ['heartbeat.policy.defaults.morningCheckIn.cron', 'not a cron', 'invalid-cron'],
    ['heartbeat.policy.quietHours.start', '25:00', 'invalid-clock-time'],
  ])('refuses %s = %p', (field, value, code) => {
    const set = (doc: Record<string, unknown>, dotted: string, v: unknown): void => {
      const parts = dotted.split('.');
      let cursor: Record<string, unknown> = doc;
      for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
      cursor[parts[parts.length - 1]] = v;
    };
    const result = decode(validDoc(tmpDir, (doc) => set(doc, field, value)), tmpDir);

    expect(issueCodes(result)).toContain(code);
    expect(issueFields(result)).toContain(field);
  });

  it('refuses search weights that do not sum to one', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      const memory = doc.memory as { search: { hybridWeights: unknown } };
      memory.search.hybridWeights = { vector: 0.9, keyword: 0.9 };
    }), tmpDir);

    expect(issueCodes(result)).toContain('weights-not-normalized');
  });

  it('refuses out-of-order session window thresholds', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      const sessions = doc.sessions as { window: unknown };
      sessions.window = { pruneAtPercent: 90, compactAtPercent: 50, emergencyAtPercent: 80, keepRecentTurns: 10 };
    }), tmpDir);

    expect(issueCodes(result)).toContain('thresholds-out-of-order');
  });

  it.each([
    ['uppercase id', 'Owner', 'invalid-owner-id'],
    ['traversal id', '../escape', 'invalid-owner-id'],
    ['relative base dir', undefined, 'invalid-absolute-path'],
  ])('refuses %s', (_label, ownerId, code) => {
    const baseDir = code === 'invalid-absolute-path' ? 'relative/state' : path.join(tmpDir, 'state');
    const doc = validDoc(tmpDir, (d) => {
      d.profiles = { baseDir, defaultProfileId: ownerId ?? 'owner' };
    });
    const result = decode(doc, tmpDir);

    expect(issueCodes(result)).toContain(code);
  });

  it('expands a ~/ owner base directory with the injected home directory', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      doc.profiles = { baseDir: '~/state', defaultProfileId: 'owner' };
    }), tmpDir);

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.config.profiles.baseDir).toBe(path.join(tmpDir, 'state'));
    expect(result.config.profiles.baseDir).not.toContain('~');
  });

  it('refuses a cloud provider that still carries the local base URL', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      const providers = doc.providers as { main: unknown };
      providers.main = { type: 'openai', model: 'gpt-4o', apiKey: 'sk', baseUrl: 'http://localhost:11434/v1' };
    }), tmpDir);

    expect(issueCodes(result)).toContain('invalid-url');
  });

  it('provides heartbeat policy and hardening defaults for omitted settings', () => {
    const result = decode(validDoc(tmpDir), tmpDir);

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.config.heartbeat.policy.quietHours.enabled).toBe(true);
    expect(result.config.heartbeat.policy.skipIfChatActiveWithinMinutes).toBe(60);
    expect(result.config.heartbeat.policy.defaults.morningCheckIn.enabled).toBe(true);
    expect(result.config.heartbeat.policy.defaults.eveningSummary.enabled).toBe(true);
    expect(result.config.heartbeat.recovery.enabled).toBe(false);
    expect(result.config.heartbeat.recovery.windowMinutes).toBe(60);
    expect(result.config.heartbeat.retry.maxRetries).toBe(3);
    expect(result.config.heartbeat.retry.backoffMinutes).toBe(5);
    expect(result.config.heartbeat.rateLimit.maxGlobalTriggersPerMinute).toBe(10);
    expect(result.config.heartbeat.rateLimit.maxPerChatTriggersPerMinute).toBe(3);
  });

  it('allows overriding quiet hours and the default routines', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      (doc.heartbeat as Record<string, unknown>).policy = {
        quietHours: { enabled: false, start: '23:00', end: '06:00' },
        skipIfChatActiveWithinMinutes: 15,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'unused' },
          eveningSummary: { enabled: true, cron: '0 21 * * *', prompt: 'Summarize the day.' },
        },
      };
    }), tmpDir);

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.config.heartbeat.policy.quietHours.enabled).toBe(false);
    expect(result.config.heartbeat.policy.quietHours.start).toBe('23:00');
    expect(result.config.heartbeat.policy.skipIfChatActiveWithinMinutes).toBe(15);
    expect(result.config.heartbeat.policy.defaults.morningCheckIn.enabled).toBe(false);
    expect(result.config.heartbeat.policy.defaults.eveningSummary.prompt).toBe('Summarize the day.');
  });

  it('allows overriding heartbeat hardening defaults', () => {
    const result = decode(validDoc(tmpDir, (doc) => {
      const heartbeat = doc.heartbeat as Record<string, unknown>;
      heartbeat.recovery = { enabled: true, windowMinutes: 180 };
      heartbeat.retry = { maxRetries: 7, backoffMinutes: 12 };
      heartbeat.rateLimit = { maxGlobalTriggersPerMinute: 4, maxPerChatTriggersPerMinute: 2 };
    }), tmpDir);

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.config.heartbeat.recovery.enabled).toBe(true);
    expect(result.config.heartbeat.recovery.windowMinutes).toBe(180);
    expect(result.config.heartbeat.retry.maxRetries).toBe(7);
    expect(result.config.heartbeat.rateLimit.maxPerChatTriggersPerMinute).toBe(2);
  });

  // RETIRED -> the old rule required a token only when enabled, and the shipped default
  // (enabled with an empty token) was therefore undecodable. The rule is unchanged; the
  // default is now disabled, which is the truthful pairing-pending state.
  it('requires a bot token exactly when telegram is enabled', () => {
    const disabledNoToken = decode(validDoc(tmpDir), tmpDir);
    expect(disabledNoToken.kind).toBe('valid');

    const enabledNoToken = decode(validDoc(tmpDir, (doc) => {
      doc.channels = { telegram: { enabled: true, botToken: '' } };
    }), tmpDir);
    expect(issueCodes(enabledNoToken)).toContain('missing-secret');
    expect(issueFields(enabledNoToken)).toContain('channels.telegram.botToken');

    const configured = decode(validDoc(tmpDir, (doc) => {
      doc.channels = { telegram: { enabled: true, botToken: '123:token' } };
    }), tmpDir);
    expect(configured.kind).toBe('valid');
  });

  it('warns that a disabled telegram channel is pairing-pending rather than ready', () => {
    const stored = storedConfigFor(path.join(tmpDir, 'state'), 'owner');
    const config = effectiveConfigFor(stored);
    const result = validateConfig(config);

    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toContain('pairing-pending');
  });
});

describe('effective config assembly', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // RETIRED -> `memory.workspace` came from the document and was asserted to equal it.
  // The workspace is now derived from the selected owner, so the assertion is stronger:
  // it proves identity selection determines every path, and the document cannot move them.
  it('derives every owner path from the selected identity, ignoring any stored path', async () => {
    const fixture = writeConfigFixture(tmpDir, { ownerId: 'shridhar' });
    const config = await loadRuntimeConfig({ configPath: fixture.configPath, homeDir: tmpDir });

    expect(config.profiles.defaultProfileId).toBe('shridhar');
    expect(config.memory.workspace).toBe(fixture.workspace);
    expect(config.heartbeat.storePath).toBe(fixture.storePath);
    expect(config.heartbeat.audit.path).toBe(fixture.auditLogPath);

    const persisted = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
    expect(persisted.memory).not.toHaveProperty('workspace');
    expect(persisted.heartbeat).not.toHaveProperty('storePath');
    expect(persisted.heartbeat).not.toHaveProperty('audit');
  });

  it('refuses to serve when the selected document is missing', async () => {
    await expect(
      loadRuntimeConfig({ configPath: path.join(tmpDir, 'absent.json'), homeDir: tmpDir }),
    ).rejects.toThrow(/npm run cli -- onboard/);
  });

  it('writes owner-only config bytes, creates the parent, and leaves no temp file', () => {
    const target = path.join(tmpDir, 'nested', 'config.json');
    const outcome = writeConfigDocument(target, storedConfigFor(path.join(tmpDir, 'state'), 'owner'));

    expect(outcome.status).toBe('committed');
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).schemaVersion).toBe(2);
    expect(fs.readdirSync(path.dirname(target)).filter((entry) => entry.includes('tmp'))).toEqual([]);
  });

  it('does not give a new config file group or world permissions', () => {
    const target = path.join(tmpDir, 'config.json');
    const oldUmask = process.umask(0o000);
    try {
      writeConfigDocument(target, storedConfigFor(path.join(tmpDir, 'state'), 'owner'));
    } finally {
      process.umask(oldUmask);
    }

    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('does not widen stricter existing owner-only config permissions', () => {
    const target = path.join(tmpDir, 'config.json');
    fs.writeFileSync(target, '{}', { mode: 0o400 });

    const outcome = writeConfigDocument(target, storedConfigFor(path.join(tmpDir, 'state'), 'owner'));

    expect(outcome.status).toBe('committed');
    expect(fs.statSync(target).mode & 0o777).toBe(0o400);
  });

  // RETIRED -> `validateConfig` reported prose messages ("... is required"). The rules are
  // the same; the contract is now an allowlisted code plus field, and the same rule set
  // refuses the document at decode time.
  it('reports the same rules as allowlisted issue codes', () => {
    const config = getDefaultConfig();
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = '';
    config.providers.main.model = '';

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('providers.main.model'),
      expect.stringContaining('channels.telegram.botToken'),
    ]));

    const stored = toStoredView(config);
    const decoded = decode(stored, os.homedir());
    expect(issueFields(decoded)).toEqual(expect.arrayContaining(['providers.main.model', 'channels.telegram.botToken']));
  });

  it('redacts provider api keys and telegram tokens', () => {
    const config = getDefaultConfig();
    config.providers.main = { type: 'openai', model: 'gpt-4o', apiKey: 'sk-secret' };
    config.channels.telegram.botToken = '123456:secret-token';

    const redacted = redactConfig(config);

    expect(redacted.providers.main.apiKey).toBe('[REDACTED]');
    expect(redacted.channels.telegram.botToken).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toContain('sk-secret');
    expect(JSON.stringify(redacted)).not.toContain('secret-token');
  });
});

describe('bounded config file IO', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a document above the 256 KiB read cap instead of loading it', () => {
    const fixture = writeConfigFixture(tmpDir);
    const padded = fs.readFileSync(fixture.configPath, 'utf8');
    fs.writeFileSync(fixture.configPath, `${padded}${' '.repeat(256 * 1024)}`);

    expect(() => readConfigDocument(fixture.configPath, tmpDir)).toThrow(/unusable \(too-large\)/);
  });

  it('refuses a hard-linked config rather than leaving an alias out of step', () => {
    const fixture = writeConfigFixture(tmpDir);
    const alias = path.join(tmpDir, 'alias.json');
    fs.linkSync(fixture.configPath, alias);

    expect(() => readConfigDocument(alias, tmpDir)).toThrow(/hard-linked/);
  });

  it('resolves a symlinked config to its target', () => {
    const fixture = writeConfigFixture(tmpDir);
    const link = path.join(tmpDir, 'linked.json');
    fs.symlinkSync(fixture.configPath, link);

    const read = readConfigDocument(link, tmpDir);

    expect(fs.realpathSync(read.canonicalPath)).toBe(fs.realpathSync(fixture.configPath));
  });
});
