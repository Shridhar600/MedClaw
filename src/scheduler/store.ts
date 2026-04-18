import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  CreateHeartbeatJobInput,
  HeartbeatJob,
  HeartbeatLastOutcome,
  UpdateHeartbeatJobInput,
} from './types';

export class HeartbeatStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<HeartbeatJob[]> {
    return this.readJobs();
  }

  async get(id: string): Promise<HeartbeatJob | undefined> {
    return this.readJobs().find((job) => job.id === id);
  }

  async findByPolicyKey(policyKey: string): Promise<HeartbeatJob | undefined> {
    return this.readJobs().find((job) => job.policyKey === policyKey);
  }

  async create(input: CreateHeartbeatJobInput): Promise<HeartbeatJob> {
    const jobs = this.readJobs();
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
      policyKey: input.policyKey,
      createdAt: now,
      updatedAt: now,
    };
    jobs.push(job);
    this.writeJobs(jobs);
    return job;
  }

  async update(id: string, patch: UpdateHeartbeatJobInput): Promise<HeartbeatJob> {
    const jobs = this.readJobs();
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
    const jobs = this.readJobs();
    const next = jobs.filter((job) => job.id !== id);
    if (next.length === jobs.length) {
      return false;
    }
    this.writeJobs(next);
    return true;
  }

  async markRun(id: string, at: string): Promise<void> {
    const jobs = this.readJobs();
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
    const jobs = this.readJobs();
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
    const jobs = this.readJobs();
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

  private readJobs(): HeartbeatJob[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (raw.length === 0) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Heartbeat store payload must be an array.');
      }
      return parsed as HeartbeatJob[];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        const quarantinedPath = this.quarantineCorruptFile();
        console.error(
          `[scheduler] Corrupt heartbeat store recovered: ${reason}. Quarantined at ${quarantinedPath}.`,
        );
      } catch (quarantineError) {
        const quarantineReason = quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
        console.error(
          `[scheduler] Corrupt heartbeat store recovered: ${reason}. Quarantine failed: ${quarantineReason}. Using empty store.`,
        );
      }
      return [];
    }
  }

  private writeJobs(jobs: HeartbeatJob[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(jobs, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  private quarantineCorruptFile(): string {
    const quarantinedPath = `${this.filePath}.corrupt-${Date.now()}`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.renameSync(this.filePath, quarantinedPath);
    return quarantinedPath;
  }
}
