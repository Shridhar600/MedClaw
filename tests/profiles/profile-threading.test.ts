import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { LLMProvider } from '../../src/providers/types';
import { MemoryEngine } from '../../src/memory/memory-engine';
import { SqliteStore } from '../../src/memory/sqlite-store';
import { MemoryIndexer } from '../../src/memory/indexer';
import { MemorySearch } from '../../src/memory/search';
import { ContextAssembler } from '../../src/agent/context';
import { HeartbeatStore } from '../../src/scheduler/store';
import { SchedulerAuditLog } from '../../src/scheduler/audit-log';
import { DEFAULT_CONFIG, cloneDefaultConfig } from '../../src/config/defaults';
import { loadConfig } from '../../src/config/config';

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

describe('ProfileConfig defaults', () => {
  it('DEFAULT_CONFIG includes profiles section', () => {
    expect(DEFAULT_CONFIG.profiles).toBeDefined();
    expect(DEFAULT_CONFIG.profiles!.baseDir).toContain('.redacted');
    expect(DEFAULT_CONFIG.profiles!.defaultProfileId).toBe('default');
  });

  it('cloneDefaultConfig includes profiles section', () => {
    const config = cloneDefaultConfig();
    expect(config.profiles).toBeDefined();
    expect(config.profiles!.defaultProfileId).toBe('default');
  });

  it('loadConfig with no config file uses defaults including profiles', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const config = await loadConfig({ configPath: '/nonexistent/config.json' });
    expect(config.profiles).toBeDefined();
    expect(config.profiles!.baseDir).toContain('.redacted');
    expect(config.profiles!.defaultProfileId).toBe('default');
    consoleWarnSpy.mockRestore();
  });

  it('merged config preserves user profiles section', async () => {
    const testConfigPath = path.join(tmpDir, 'test-config.json');
    const userConfig = {
      profiles: { baseDir: '/custom/path', defaultProfileId: 'work' },
    };
    fs.mkdirSync(path.dirname(testConfigPath), { recursive: true });
    fs.writeFileSync(testConfigPath, JSON.stringify(userConfig), 'utf8');

    const config = await loadConfig({ configPath: testConfigPath });
    expect(config.profiles).toBeDefined();
    expect(config.profiles!.baseDir).toBe('/custom/path');
    expect(config.profiles!.defaultProfileId).toBe('work');
  });
});
