import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeOnboardingProfile } from '../../src/onboarding/profile-writer';
import type { OnboardingAnswers } from '../../src/onboarding/types';

describe('writeOnboardingProfile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-profile-writer-'));
    fs.writeFileSync(path.join(tmpDir, 'USER.md'), '# User Preferences\n\nKeep this user edit.\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'HEALTH_PROFILE.md'), '# Health Profile\n\nKeep this health edit.\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends deterministic onboarding sections without deleting existing edits', async () => {
    const answers: OnboardingAnswers = {
      name: 'Arjun',
      age: '31',
      timezone: 'Asia/Kolkata',
      conditions: 'Type 2 diabetes',
      medications: 'Metformin',
      allergies: 'Penicillin',
      goals: 'Improve glucose control',
      reminderPreferences: 'Morning reminders',
    };

    await writeOnboardingProfile(tmpDir, answers);

    const user = fs.readFileSync(path.join(tmpDir, 'USER.md'), 'utf8');
    const profile = fs.readFileSync(path.join(tmpDir, 'HEALTH_PROFILE.md'), 'utf8');
    expect(user).toContain('Keep this user edit.');
    expect(user).toContain('Name: Arjun');
    expect(user).toContain('Timezone: Asia/Kolkata');
    expect(user).toContain('Reminder preferences: Morning reminders');
    expect(profile).toContain('Keep this health edit.');
    expect(profile).toContain('Age: 31');
    expect(profile).toContain('Active conditions: Type 2 diabetes');
    expect(profile).toContain('Current medications: Metformin');
  });

  it('replaces only the managed onboarding section on repeated writes', async () => {
    await writeOnboardingProfile(tmpDir, { name: 'Old name', timezone: 'UTC' });
    await writeOnboardingProfile(tmpDir, { name: 'New name', timezone: 'Asia/Kolkata' });

    const user = fs.readFileSync(path.join(tmpDir, 'USER.md'), 'utf8');
    expect(user).toContain('Name: New name');
    expect(user).not.toContain('Name: Old name');
    expect(user).toContain('Keep this user edit.');
  });
});
