import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline/promises';

let sharedReadline: readline.Interface | undefined;
let pipedAnswers: string[] | undefined;

export interface CliIO {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  input?: (prompt: string) => Promise<string>;
}

export const WORKSPACE_FILES: Record<string, string> = {
  'SOUL.md': `# SOUL — Redacted Health Companion

## Identity
You are Redacted, a personal AI health companion. You are empathetic, knowledgeable, and proactive. You remember the user's health history and provide context-aware guidance.

## Core Values
- **Personalized**: Every answer accounts for the user's specific conditions, medications, and goals
- **Honest**: You say "I don't know" rather than guessing on medical matters
- **Proactive**: You notice patterns and suggest follow-ups without being asked
- **Safe**: You never diagnose, never contradict doctors, always recommend professional consultation
`,
  'HEALTH_PROFILE.md': `# Health Profile

> This file is ALWAYS loaded. Keep it under 2,000 tokens. For detailed info, use the conditions/ and medications/ files.

## Basic Info
- **Name**: [User's name]
- **Age**: [Age]
- **Gender**: [Gender]
- **Timezone**: Asia/Kolkata

## Active Conditions
- None recorded yet

## Current Medications
- None recorded yet

## Known Allergies
- None recorded yet

## Recent Reports
- None uploaded yet

## Goals
- None set yet

## Emergency Contact
- [Doctor name]: [Phone]
`,
  'USER.md': `# User Preferences

## Communication
- **Language**: English
- **Timezone**: Asia/Kolkata
- **Address me as**: [Name]
- **Preferred detail level**: Medium

## Diet
- **Type**: [Vegetarian/Non-vegetarian/Vegan]
- **Restrictions**: [Any restrictions]
- **Cuisine**: Indian (primary), occasional continental

## Lifestyle
- **Activity level**: [Sedentary/Moderate/Active]
- **Sleep schedule**: [Approx. sleep/wake times]
- **Work schedule**: [9-6 weekdays / etc]

## Health Priorities
1. [Top priority]
2. [Second priority]

## Notification Preferences
- Morning check-in: 8:00 AM
- Evening summary: 9:00 PM
- Medication reminders: [yes/no]
`,
  'HEARTBEAT.md': `# Heartbeat Schedule

Current runtime status:
- Scheduler runtime is active when \`heartbeat.enabled\` is true and a channel is available.
- This file is derived from the durable JSON heartbeat store and synchronized by runtime/tools.
- Delivery state shows whether a job is ready, snoozed, waiting for retry, or dead-lettered.
- Retry and acknowledgement fields reflect runtime control state, not just cron metadata.
- Policy-managed system jobs are derived from structured files in \`medications/\`, \`conditions/\`, and \`goals/\`.

## Jobs
- (none)
`,
};

export async function askText(
  io: CliIO,
  prompt: string,
  defaultValue = '',
): Promise<string> {
  if (io.input) {
    const answer = await io.input(defaultValue ? `${prompt} [${defaultValue}] ` : `${prompt} `);
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : defaultValue;
  }

  const promptText = defaultValue ? `${prompt} [${defaultValue}] ` : `${prompt} `;

  if (!process.stdin.isTTY) {
    process.stdout.write(promptText);
    if (!pipedAnswers) {
      pipedAnswers = fs.readFileSync(0, 'utf8').split(/\r?\n/);
    }
    const answer = pipedAnswers.shift() ?? '';
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : defaultValue;
  }

  if (!sharedReadline) {
    sharedReadline = readline.createInterface({
      input: process.stdin as unknown as NodeJS.ReadStream,
      output: process.stdout as unknown as NodeJS.WriteStream,
    });
  }
  const answer = await sharedReadline.question(promptText);
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}

export async function askYesNo(
  io: CliIO,
  prompt: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  const answer = await askText(io, `${prompt} (${suffix})`, defaultValue ? 'y' : 'n');
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes' || normalized === 'true';
}

export function ensureWorkspaceTemplates(workspacePath: string): void {
  fs.mkdirSync(workspacePath, { recursive: true });
  for (const [fileName, template] of Object.entries(WORKSPACE_FILES)) {
    const fullPath = path.join(workspacePath, fileName);
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, template, 'utf8');
    }
  }

  for (const dirName of ['conditions', 'medications', 'reports', 'goals', 'memory', 'summaries', 'archive']) {
    fs.mkdirSync(path.join(workspacePath, dirName), { recursive: true });
  }
}
