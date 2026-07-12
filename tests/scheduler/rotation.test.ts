import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { rotateFileIfNeeded } from '../../src/scheduler/rotation';

describe('rotateFileIfNeeded', () => {
  let tmpDir: string;
  const defaultConfig = { maxSizeBytes: 50, maxArchived: 3 };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rotation-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not rotate a file smaller than maxSizeBytes', () => {
    const filePath = path.join(tmpDir, 'audit.jsonl');
    fs.writeFileSync(filePath, 'small content');

    const rotated = rotateFileIfNeeded(filePath, defaultConfig);

    expect(rotated).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('small content');
    expect(fs.existsSync(filePath + '.1.gz')).toBe(false);
  });

  it('rotates when file exceeds maxSizeBytes and archive is valid gzip', () => {
    const filePath = path.join(tmpDir, 'audit.jsonl');
    const content = 'x'.repeat(100); // > 50 bytes
    fs.writeFileSync(filePath, content);

    const rotated = rotateFileIfNeeded(filePath, defaultConfig);

    expect(rotated).toBe(true);
    // Original file should be truncated
    expect(fs.readFileSync(filePath, 'utf8')).toBe('');
    // Archive should exist as gzip
    const archivePath = filePath + '.1.gz';
    expect(fs.existsSync(archivePath)).toBe(true);
    // Decompress and verify content
    const compressed = fs.readFileSync(archivePath);
    const decompressed = zlib.gunzipSync(compressed).toString('utf8');
    expect(decompressed).toBe(content);
  });

  it('prunes archives beyond maxArchived', () => {
    const filePath = path.join(tmpDir, 'audit.jsonl');
    const content = 'x'.repeat(100);

    // Rotate maxArchived + 1 times
    for (let i = 0; i <= defaultConfig.maxArchived; i++) {
      fs.writeFileSync(filePath, content + `-${i}`);
      rotateFileIfNeeded(filePath, defaultConfig);
    }

    // Should only keep maxArchived archives
    const archives = fs.readdirSync(tmpDir).filter(f => f.startsWith('audit.jsonl.'));
    expect(archives).toHaveLength(defaultConfig.maxArchived);
    // Should NOT have the oldest (index-0) archive
    const oldestContent = content + '-0';
    const allArchives = archives.sort();
    for (const arch of allArchives) {
      const compressed = fs.readFileSync(path.join(tmpDir, arch));
      const decompressed = zlib.gunzipSync(compressed).toString('utf8');
      expect(decompressed).not.toBe(oldestContent);
    }
  });

  it('shifts archive numbers on successive rotations', () => {
    const filePath = path.join(tmpDir, 'audit.jsonl');
    const content = 'y'.repeat(100);

    // First rotation
    fs.writeFileSync(filePath, content + '-1');
    rotateFileIfNeeded(filePath, defaultConfig);
    expect(fs.existsSync(filePath + '.1.gz')).toBe(true);

    // Second rotation
    fs.writeFileSync(filePath, content + '-2');
    rotateFileIfNeeded(filePath, defaultConfig);
    expect(fs.existsSync(filePath + '.1.gz')).toBe(true);
    expect(fs.existsSync(filePath + '.2.gz')).toBe(true);

    // Verify content: .2.gz should have the older content
    const compressed1 = fs.readFileSync(filePath + '.1.gz');
    expect(zlib.gunzipSync(compressed1).toString('utf8')).toBe(content + '-2');

    const compressed2 = fs.readFileSync(filePath + '.2.gz');
    expect(zlib.gunzipSync(compressed2).toString('utf8')).toBe(content + '-1');
  });

  it('does nothing when file does not exist', () => {
    const filePath = path.join(tmpDir, 'nonexistent.jsonl');

    const rotated = rotateFileIfNeeded(filePath, defaultConfig);

    expect(rotated).toBe(false);
  });

  it('uses default config when not provided', () => {
    const filePath = path.join(tmpDir, 'audit.jsonl');
    fs.writeFileSync(filePath, 'x'.repeat(5));

    const rotated = rotateFileIfNeeded(filePath);

    expect(rotated).toBe(false);
  });

  it('rotates above 50MB when using defaults', () => {
    const filePath = path.join(tmpDir, 'audit.jsonl');
    fs.writeFileSync(filePath, 'x'.repeat(51 * 1024 * 1024));

    const rotated = rotateFileIfNeeded(filePath);

    expect(rotated).toBe(true);
  });
});
