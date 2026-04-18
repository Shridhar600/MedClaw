import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HeartbeatPolicyConfig } from '../../src/config/types';
import { buildDesiredHeartbeatJobs } from '../../src/scheduler/policy-engine';

function makeHeartbeatPolicy(): HeartbeatPolicyConfig {
  return {
    quietHours: { enabled: true, start: '22:00', end: '07:00' },
    skipIfChatActiveWithinMinutes: 60,
    defaults: {
      morningCheckIn: {
        enabled: true,
        cron: '0 8 * * *',
        prompt: 'Morning check-in prompt.',
      },
      eveningSummary: {
        enabled: true,
        cron: '0 21 * * *',
        prompt: 'Evening summary prompt.',
      },
    },
  };
}

describe('policy-engine', () => {
  let tmpDir: string;
  let workspacePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-policy-engine-'));
    workspacePath = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspacePath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds default morning and evening routine jobs from config', async () => {
    const desired = await buildDesiredHeartbeatJobs({
      workspacePath,
      chatId: 'chat-1',
      timezone: 'Asia/Kolkata',
      policy: makeHeartbeatPolicy(),
    });

    expect(desired.map((job) => job.policyKey)).toEqual(
      expect.arrayContaining(['defaults:morning-check-in', 'defaults:evening-summary']),
    );
  });

  it('builds medication and recovery jobs from structured markdown frontmatter', async () => {
    fs.mkdirSync(path.join(workspacePath, 'medications'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'conditions'), { recursive: true });

    fs.writeFileSync(
      path.join(workspacePath, 'medications', 'metformin.md'),
      '---\nstatus: active\ncron: "0 8,20 * * *"\nprompt: "Remind about Metformin."\n---\n# Metformin\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspacePath, 'conditions', 'knee.md'),
      '---\nstatus: active\ncron: "0 20 * * *"\nprompt: "Ask about knee pain today."\n---\n# Knee recovery\n',
      'utf8',
    );

    const desired = await buildDesiredHeartbeatJobs({
      workspacePath,
      chatId: 'chat-1',
      timezone: 'Asia/Kolkata',
      policy: makeHeartbeatPolicy(),
    });

    expect(desired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'medication',
          policyKey: 'medications:medications/metformin.md',
        }),
        expect.objectContaining({
          kind: 'recovery',
          policyKey: 'conditions:conditions/knee.md',
        }),
      ]),
    );
  });
});
