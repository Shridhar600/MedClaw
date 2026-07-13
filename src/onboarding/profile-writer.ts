import * as fs from 'fs';
import * as path from 'path';
import { secureMkdir, secureWriteViaTmp } from '../security';
import type { OnboardingAnswers } from './types';

const USER_START = '<!-- REDACTED_ONBOARDING_USER_START -->';
const USER_END = '<!-- REDACTED_ONBOARDING_USER_END -->';
const HEALTH_START = '<!-- REDACTED_ONBOARDING_HEALTH_START -->';
const HEALTH_END = '<!-- REDACTED_ONBOARDING_HEALTH_END -->';

export async function writeOnboardingProfile(workspacePath: string, answers: OnboardingAnswers): Promise<void> {
  secureMkdir(workspacePath);
  updateManagedSection(
    path.join(workspacePath, 'USER.md'),
    renderUserSection(answers),
    USER_START,
    USER_END,
    '# User Preferences\n',
  );
  updateManagedSection(
    path.join(workspacePath, 'HEALTH_PROFILE.md'),
    renderHealthSection(answers),
    HEALTH_START,
    HEALTH_END,
    '# Health Profile\n',
  );
}

function renderUserSection(answers: OnboardingAnswers): string {
  return [
    '## Onboarding Summary',
    `- Name: ${valueOrNone(answers.name)}`,
    `- Timezone: ${valueOrNone(answers.timezone)}`,
    `- Health goals: ${valueOrNone(answers.goals)}`,
    `- Reminder preferences: ${valueOrNone(answers.reminderPreferences)}`,
  ].join('\n');
}

function renderHealthSection(answers: OnboardingAnswers): string {
  return [
    '## Onboarding Health Context',
    `- Name: ${valueOrNone(answers.name)}`,
    `- Age: ${valueOrNone(answers.age)}`,
    `- Timezone: ${valueOrNone(answers.timezone)}`,
    `- Active conditions: ${valueOrNone(answers.conditions)}`,
    `- Current medications: ${valueOrNone(answers.medications)}`,
    `- Known allergies: ${valueOrNone(answers.allergies)}`,
    `- Goals: ${valueOrNone(answers.goals)}`,
  ].join('\n');
}

function updateManagedSection(filePath: string, body: string, start: string, end: string, fallback: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : fallback;
  const section = `${start}\n${body}\n${end}`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  const next = pattern.test(existing)
    ? existing.replace(pattern, section)
    : `${existing.trimEnd()}\n\n${section}\n`;
  secureWriteViaTmp(filePath, next);
}

function valueOrNone(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'None recorded';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
