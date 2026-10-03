import * as path from 'path';
import * as os from 'os';
import type { LLMProvider } from '../../src/providers/types';
import { MemoryEngine } from '../../src/memory/memory-engine';
import { SqliteStore } from '../../src/memory/sqlite-store';
import { MemoryIndexer } from '../../src/memory/indexer';
import { MemorySearch } from '../../src/memory/search';
import { ContextAssembler } from '../../src/agent/context';
import { HeartbeatStore } from '../../src/scheduler/store';
import { SchedulerAuditLog } from '../../src/scheduler/audit-log';
import { DEFAULT_STORED_CONFIG, cloneStoredDefaults } from '../../src/config/defaults';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { writeConfigFixture } from '../helpers/config-fixture';

jest.mock('../../src/providers/types', () => ({}));

const tmpDir = path.join(os.tmpdir(), 'profile-threading-test');

describe('profileId threading', () => {
  beforeAll(() => {
    jest.restoreAllMocks();
  });

  describe('MemoryEngine', () => {
    it('constructs without profileId (defaults to "default")', () => {
      const engine = new MemoryEngine(tmpDir);
      expect(engine).toBeInstanceOf(MemoryEngine);
    });

    it('constructs with explicit profileId', () => {
      const engine = new MemoryEngine(tmpDir, 'my-profile');
      expect(engine).toBeInstanceOf(MemoryEngine);
    });
  });

  describe('SqliteStore', () => {
    it('constructs without profileId (defaults to "default")', () => {
      const dbPath = path.join(tmpDir, 'test.db');
      const store = new SqliteStore(dbPath);
      expect(store).toBeInstanceOf(SqliteStore);
      store.close();
    });

    it('constructs with explicit profileId', () => {
      const dbPath = path.join(tmpDir, 'test2.db');
      const store = new SqliteStore(dbPath, 'my-profile');
      expect(store).toBeInstanceOf(SqliteStore);
      store.close();
    });
  });

  describe('MemoryIndexer', () => {
    it('constructs without profileId (defaults to "default")', () => {
      const dbPath = path.join(tmpDir, 'indexer.db');
      const store = new SqliteStore(dbPath);
      const mockProvider = { embed: jest.fn(), modelName: 'test-model' } as unknown as LLMProvider;
      const indexer = new MemoryIndexer(store, mockProvider, tmpDir);
      expect(indexer).toBeInstanceOf(MemoryIndexer);
      store.close();
    });

    it('constructs with explicit profileId', () => {
      const dbPath = path.join(tmpDir, 'indexer2.db');
      const store = new SqliteStore(dbPath);
      const mockProvider = { embed: jest.fn(), modelName: 'test-model' } as unknown as LLMProvider;
      const indexer = new MemoryIndexer(store, mockProvider, tmpDir, 'my-profile');
      expect(indexer).toBeInstanceOf(MemoryIndexer);
      store.close();
    });
  });

  describe('MemorySearch', () => {
    it('constructs without profileId (defaults to "default")', () => {
      const dbPath = path.join(tmpDir, 'search.db');
      const store = new SqliteStore(dbPath);
      const mockProvider = { embed: jest.fn() } as unknown as LLMProvider;
      const weights = { vector: 0.7, keyword: 0.3 };
      const search = new MemorySearch(store, mockProvider, weights);
      expect(search).toBeInstanceOf(MemorySearch);
      store.close();
    });

    it('constructs with explicit profileId', () => {
      const dbPath = path.join(tmpDir, 'search2.db');
      const store = new SqliteStore(dbPath);
      const mockProvider = { embed: jest.fn() } as unknown as LLMProvider;
      const weights = { vector: 0.7, keyword: 0.3 };
      const search = new MemorySearch(store, mockProvider, weights, 'my-profile');
      expect(search).toBeInstanceOf(MemorySearch);
      store.close();
    });
  });

  describe('ContextAssembler', () => {
    it('constructs without profileId (defaults to "default")', () => {
      const engine = new MemoryEngine(tmpDir);
      const assembler = new ContextAssembler(engine, 1000);
      expect(assembler).toBeInstanceOf(ContextAssembler);
    });

    it('constructs with explicit profileId', () => {
      const engine = new MemoryEngine(tmpDir);
      const assembler = new ContextAssembler(engine, 1000, 'my-profile');
      expect(assembler).toBeInstanceOf(ContextAssembler);
    });
  });

  describe('HeartbeatStore', () => {
    it('constructs without profileId (defaults to "default")', () => {
      const filePath = path.join(tmpDir, 'heartbeats.json');
      const store = new HeartbeatStore(filePath);
      expect(store).toBeInstanceOf(HeartbeatStore);
    });

    it('constructs with explicit profileId', () => {
      const filePath = path.join(tmpDir, 'heartbeats2.json');
      const store = new HeartbeatStore(filePath, 'my-profile');
      expect(store).toBeInstanceOf(HeartbeatStore);
    });
  });

  describe('SchedulerAuditLog', () => {
    it('constructs without profileId (defaults to "default")', () => {
      const filePath = path.join(tmpDir, 'audit.jsonl');
      const log = new SchedulerAuditLog(filePath);
      expect(log).toBeInstanceOf(SchedulerAuditLog);
    });

    it('constructs with explicit profileId', () => {
      const filePath = path.join(tmpDir, 'audit2.jsonl');
      const log = new SchedulerAuditLog(filePath, 'my-profile');
      expect(log).toBeInstanceOf(SchedulerAuditLog);
    });
  });
});

describe('selected owner identity', () => {
  it('the stored defaults name an owner base directory and a default owner ID', () => {
    expect(DEFAULT_STORED_CONFIG.profiles).toBeDefined();
    expect(DEFAULT_STORED_CONFIG.profiles.baseDir).toBe('~/.redacted');
    expect(DEFAULT_STORED_CONFIG.profiles.defaultProfileId).toBe('default');
  });

  it('a cloned default carries no shared reference to the defaults', () => {
    const first = cloneStoredDefaults();
    first.profiles.defaultProfileId = 'mutated';
    expect(cloneStoredDefaults().profiles.defaultProfileId).toBe('default');
  });

  // RETIRED -> `loadConfig` on an absent file returned full defaults, so a machine that had
  // never been set up resolved to an owner. Serving now refuses instead; the default owner
  // name exists only as a setup value.
  it('refuses to serve when no configuration document is selected', async () => {
    await expect(
      loadRuntimeConfig({ configPath: '/nonexistent/config.json', homeDir: tmpDir }),
    ).rejects.toThrow(/Config file not found/);
  });

  it('derives the owner workspace from the selected identity', async () => {
    const fixture = writeConfigFixture(tmpDir, { baseDir: '/custom/path', ownerId: 'work' });

    const config = await loadRuntimeConfig({ configPath: fixture.configPath, homeDir: tmpDir });

    expect(config.profiles.baseDir).toBe('/custom/path');
    expect(config.profiles.defaultProfileId).toBe('work');
    expect(config.memory.workspace).toBe('/custom/path/profiles/work');
    expect(config.heartbeat.storePath).toBe('/custom/path/profiles/work/.state/heartbeat-jobs.json');
  });

  it('refuses an owner ID that is not a valid identity', async () => {
    const fixture = writeConfigFixture(tmpDir, { raw: '{ "schemaVersion": 2, "profiles": { "baseDir": "/custom/path", "defaultProfileId": "Work Owner" } }' });

    await expect(
      loadRuntimeConfig({ configPath: fixture.configPath, homeDir: tmpDir }),
    ).rejects.toThrow(/profiles.defaultProfileId/);
  });
});
