import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { secureMkdir, secureWriteViaTmp, summarizeErrorForLog, tightenFile } from '../security';
import type {
  CreateHeartbeatJobInput,
  HeartbeatJob,
  HeartbeatLastOutcome,
  UpdateHeartbeatJobInput,
} from './types';

interface JobsCache {
  mtimeMs: number;
  size: number;
  ino: number;
  jobs: HeartbeatJob[];
}

export class HeartbeatStore {
  public lastCorruptionAt?: string;
  private jobsCache?: JobsCache;

  constructor(
    private readonly filePath: string,
    private readonly profileId: string = 'default',
  ) {}

  async list(): Promise<HeartbeatJob[]> {
    return this.readJobs();
  }

  async get(id: string): Promise<HeartbeatJob | undefined> {
    return (await this.readJobs()).find((job) => job.id === id);
  }

  async findByPolicyKey(policyKey: string): Promise<HeartbeatJob | undefined> {
    return (await this.readJobs()).find((job) => job.policyKey === policyKey);
  }

  async create(input: CreateHeartbeatJobInput): Promise<HeartbeatJob> {
    const jobs = await this.readJobs();
    if (input.policyKey) {
      const duplicate = jobs.find((job) => job.policyKey === input.policyKey);
      if (duplicate) {
        throw new Error(`Duplicate heartbeat policy key: ${input.policyKey}`);
      }
    }
    const now = new Date().toISOString();
    const job: HeartbeatJob = {
      id: randomUUID(),
      title: input.title,
      chatId: input.chatId,
      cron: input.cron,
      timezone: input.timezone ?? 'Asia/Kolkata',
      prompt: input.prompt,
      enabled: true,
      source: input.source,
      kind: input.kind,
      deliveryState: 'ready',
      retryCount: 0,
      maxRetries: input.maxRetries ?? 0,
      policyKey: input.policyKey,
      createdAt: now,
      updatedAt: now,
    };
    jobs.push(job);
    this.writeJobs(jobs);
    return job;
  }

  async update(id: string, patch: UpdateHeartbeatJobInput): Promise<HeartbeatJob> {
    const jobs = await this.readJobs();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }

    const current = jobs[index];
    const updated: HeartbeatJob = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    jobs[index] = updated;
    this.writeJobs(jobs);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const jobs = await this.readJobs();
    const next = jobs.filter((job) => job.id !== id);
    if (next.length === jobs.length) {
      return false;
    }
    this.writeJobs(next);
    return true;
  }

  async markRun(id: string, at: string): Promise<void> {
    const jobs = await this.readJobs();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }

    jobs[index] = {
      ...jobs[index],
      lastRunAt: at,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.writeJobs(jobs);
  }

  async markError(id: string, message: string): Promise<void> {
    const jobs = await this.readJobs();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }

    jobs[index] = {
      ...jobs[index],
      lastError: message,
      lastOutcome: 'error',
      lastOutcomeAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.writeJobs(jobs);
  }

  async markOutcome(id: string, outcome: HeartbeatLastOutcome): Promise<void> {
    const jobs = await this.readJobs();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      throw new Error(`Heartbeat job not found: ${id}`);
    }

    jobs[index] = {
      ...jobs[index],
      lastOutcome: outcome,
      lastOutcomeAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.writeJobs(jobs);
  }

  private async readJobs(): Promise<HeartbeatJob[]> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.jobsCache = undefined;
        return [];
      }
      throw error;
    }

    if (this.jobsCache
      && this.jobsCache.mtimeMs === stat.mtimeMs
      && this.jobsCache.size === stat.size
      && this.jobsCache.ino === stat.ino) {
      return this.cloneJobs(this.jobsCache.jobs);
    }

    if (stat.size === 0) {
      this.jobsCache = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, jobs: [] };
      return [];
    }

    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(parsed) || parsed.some((job) =>
        job === null || typeof job !== 'object' || Array.isArray(job))) {
        throw new Error('Heartbeat store payload must be an array of objects.');
      }
      this.lastCorruptionAt = undefined;
      const jobs = parsed.map((job) => this.normalizeJob(job as HeartbeatJob));
      this.jobsCache = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, jobs: this.cloneJobs(jobs) };
      return this.cloneJobs(jobs);
    } catch (error) {
      this.lastCorruptionAt = new Date().toISOString();
      console.error(
        `[scheduler] CORRUPTION DETECTED at ${this.lastCorruptionAt}`,
      );
      const reason = summarizeErrorForLog(error);
      try {
        const quarantinedPath = this.quarantineCorruptFile();
        console.error(
          `[scheduler] Corrupt heartbeat store recovered: ${reason}. Quarantined at ${quarantinedPath}.`,
        );
      } catch (quarantineError) {
        const quarantineReason = summarizeErrorForLog(quarantineError);
        console.error(
          `[scheduler] Corrupt heartbeat store recovered: ${reason}. Quarantine failed: ${quarantineReason}. Using empty store.`,
        );
      }
      this.jobsCache = undefined;
      return [];
    }
  }

  private writeJobs(jobs: HeartbeatJob[]): void {
    secureWriteViaTmp(this.filePath, JSON.stringify(jobs, null, 2));
    try {
      const stat = fs.statSync(this.filePath);
      this.jobsCache = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ino: stat.ino,
        jobs: this.cloneJobs(jobs),
      };
    } catch {
      // The durable write succeeded; if fingerprinting is unavailable, the next read reopens the file.
      this.jobsCache = undefined;
    }
  }

  private quarantineCorruptFile(): string {
    const quarantinedPath = `${this.filePath}.corrupt-${Date.now()}`;
    secureMkdir(path.dirname(this.filePath));
    fs.renameSync(this.filePath, quarantinedPath);
    // The quarantined copy may inherit a loose mode; tighten so the corrupt
    // PHI-bearing payload is not left world-readable.
    tightenFile(quarantinedPath);
    return quarantinedPath;
  }

  private normalizeJob(job: HeartbeatJob): HeartbeatJob {
    return {
      ...job,
      deliveryState: job.deliveryState ?? 'ready',
      retryCount: job.retryCount ?? 0,
      maxRetries: job.maxRetries ?? 0,
    };
  }

  private cloneJobs(jobs: HeartbeatJob[]): HeartbeatJob[] {
    return jobs.map((job) => ({ ...job }));
  }
}
