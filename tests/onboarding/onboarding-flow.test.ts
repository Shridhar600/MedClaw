import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OnboardingFlow } from '../../src/onboarding/flow';
import { OnboardingStore } from '../../src/onboarding/store';

describe('OnboardingFlow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-onboarding-flow-'));
    fs.writeFileSync(path.join(tmpDir, 'USER.md'), '# User Preferences\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'HEALTH_PROFILE.md'), '# Health Profile\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts with disclaimer and persists restart-safe step progress', async () => {
    const store = new OnboardingStore(tmpDir);
    const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');

    const first = await flow.handle('hello');
    expect(first.response).toContain('Before we start');
    expect(first.response).toContain('preferred name');

    const continued = new OnboardingFlow(new OnboardingStore(tmpDir), tmpDir, 'Asia/Kolkata');
    const second = await continued.handle('Arjun');
    expect(second.response).toContain('age');

    const state = await store.load();
    expect(state.status).toBe('in_progress');
    expect(state.currentStep).toBe('age');
    expect(state.answers.name).toBe('Arjun');
    expect(state.disclaimerShownAt).toBeDefined();
  });

  it('keeps the default timezone when the user confirms with yes', async () => {
    const store = new OnboardingStore(tmpDir);
    const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');

    await flow.handle('hello');
    await flow.handle('Arjun');
    await flow.handle('25');
    await flow.handle('yes');

    const state = await store.load();
    expect(state.currentStep).toBe('conditions');
    expect(state.answers.timezone).toBe('Asia/Kolkata');
  });


  it('completes after confirmation and writes durable profile files', async () => {
    const flow = new OnboardingFlow(new OnboardingStore(tmpDir), tmpDir, 'Asia/Kolkata');

    await flow.handle('hi');
    await flow.handle('Arjun');
    await flow.handle('31');
    await flow.handle('Asia/Kolkata');
    await flow.handle('Type 2 diabetes');
    await flow.handle('Metformin');
    await flow.handle('Penicillin');
    await flow.handle('Improve glucose control');
    const summary = await flow.handle('Morning reminders');
    expect(summary.response).toContain('Reply confirm');

    const done = await flow.handle('confirm');
    expect(done.completed).toBe(true);
    expect(done.response).toContain('onboarding is complete');

    const state = await new OnboardingStore(tmpDir).load();
    expect(state.status).toBe('complete');
    expect(state.completedAt).toBeDefined();
    expect(fs.readFileSync(path.join(tmpDir, 'USER.md'), 'utf8')).toContain('Name: Arjun');
    expect(fs.readFileSync(path.join(tmpDir, 'HEALTH_PROFILE.md'), 'utf8')).toContain('Active conditions: Type 2 diabetes');
  });

  it('accepts confirmation even when old gateway metadata polluted the saved answers', async () => {
    const stateDir = path.join(tmpDir, '.redacted');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'onboarding.json'),
      JSON.stringify({
        status: 'in_progress',
        currentStep: 'confirmation',
        answers: {
          timezone: 'Asia/Kolkata\n\nUser id: 123',
          name: 'Arjun\n\nUser id: 123',
          age: '25\n\nUser id: 123',
          conditions: 'None\n\nUser id: 123',
          medications: 'Protein-heavy diet\n\nUser id: 123',
          allergies: 'Cold foods\n\nUser id: 123',
          goals: 'Muscle gain\n\nUser id: 123',
          reminderPreferences: 'None\n\nUser id: 123',
        },
      }),
      'utf8',
    );
    const flow = new OnboardingFlow(new OnboardingStore(tmpDir), tmpDir, 'Asia/Kolkata');

    const done = await flow.handle('confirm\n\nUser id: 123');

    expect(done.completed).toBe(true);
    const profile = fs.readFileSync(path.join(tmpDir, 'HEALTH_PROFILE.md'), 'utf8');
    expect(profile).toContain('Name: Arjun');
    expect(profile).toContain('Goals: Muscle gain');
    expect(profile).not.toContain('User id: 123');
  });

  it('bypasses emergency input without completing onboarding', async () => {
    const flow = new OnboardingFlow(new OnboardingStore(tmpDir), tmpDir, 'Asia/Kolkata');

    const result = await flow.handle('I have chest pain and cannot breathe');

    expect(result.bypass).toBe(true);
    expect(result.response).toContain('emergency');
    const state = await new OnboardingStore(tmpDir).load();
    expect(state.status).toBe('not_started');
  });

  it('supports skip without corrupting profile files', async () => {
    const flow = new OnboardingFlow(new OnboardingStore(tmpDir), tmpDir, 'Asia/Kolkata');

    await flow.handle('hello');
    const skipped = await flow.handle('later');

    expect(skipped.completed).toBe(true);
    expect((await new OnboardingStore(tmpDir).load()).status).toBe('skipped');
    expect(fs.readFileSync(path.join(tmpDir, 'HEALTH_PROFILE.md'), 'utf8')).toBe('# Health Profile\n');
  });

  it('quarantines corrupt onboarding state and returns default state', async () => {
    const stateDir = path.join(tmpDir, '.redacted');
    fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, 'onboarding.json');
    fs.writeFileSync(statePath, '{not-json', 'utf8');

    const state = await new OnboardingStore(tmpDir).load();

    expect(state.status).toBe('not_started');
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith('onboarding.json.corrupt-'))).toBe(true);
  });
});
