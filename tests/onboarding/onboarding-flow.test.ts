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

  // forka #5: timezone answer validation — never store a raw phrase as the zone.
  async function driveToTimezone(flow: OnboardingFlow, tzAnswer: string): Promise<string> {
    await flow.handle('hello');   // -> name prompt
    await flow.handle('Arjun');   // -> age prompt
    await flow.handle('31');      // -> timezone prompt
    await flow.handle(tzAnswer);  // timezone step
    const store = new OnboardingStore(tmpDir);
    return (await store.load()).answers.timezone ?? '';
  }

  it('recovers a valid IANA zone from a phrase answer (forka #5)', async () => {
    const store = new OnboardingStore(tmpDir);
    const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');
    expect(await driveToTimezone(flow, 'yes America/New_York is right')).toBe('America/New_York');
  });

  it('keeps the default timezone on an affirmative answer (forka #5)', async () => {
    const store = new OnboardingStore(tmpDir);
    const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');
    expect(await driveToTimezone(flow, 'yes')).toBe('Asia/Kolkata');
  });

  it('keeps the default when the answer has no valid zone (forka #5)', async () => {
    const store = new OnboardingStore(tmpDir);
    const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');
    expect(await driveToTimezone(flow, 'sounds good to me')).toBe('Asia/Kolkata');
  });

  it('accepts a bare valid IANA zone (forka #5)', async () => {
    const store = new OnboardingStore(tmpDir);
    const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');
    expect(await driveToTimezone(flow, 'Europe/London')).toBe('Europe/London');
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

  it.each([
    'I want to kill myself',
    'I want to die',
    "I don't want to live anymore",
    "I don't want to be alive",
    'I am going to end it',
    'I plan to end my life',
    'Life is not worth living',
    'I took all my pills',
    'I may have overdosed',
    'I am thinking about self-harm',
    'They are unconscious',
    'They are unresponsive',
    'They are unconscious and not breathing',
    'This looks like anaphylaxis',
    'They are having a seizure',
  ])('bypasses onboarding for ordinary crisis phrasing: %s', async (input) => {
    const flow = new OnboardingFlow(new OnboardingStore(tmpDir), tmpDir, 'Asia/Kolkata');

    const result = await flow.handle(input);

    expect(result.bypass).toBe(true);
    expect(result.response).toContain('emergency');
    expect(result.response).toContain('I am an AI health companion, not a doctor');
  });

  it('extends built-in emergency phrases with configured literal keywords', async () => {
    const flow = new (OnboardingFlow as never as new (...args: unknown[]) => OnboardingFlow)(
      new OnboardingStore(tmpDir), tmpDir, 'Asia/Kolkata', ['code violet'],
    );

    const result = await flow.handle('Please start code violet now');

    expect(result.bypass).toBe(true);
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

  it('never logs corrupt onboarding content during quarantine', async () => {
    const stateDir = path.join(tmpDir, '.redacted');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'onboarding.json'), 'MEDICALSECRET12345', 'utf8');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await new OnboardingStore(tmpDir).load();
      const logged = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(logged).not.toContain('MEDICALSECRET12345');
      expect(logged).toContain('Corrupt onboarding state recovered');
      expect(logged).toContain('Error');
    } finally {
      errorSpy.mockRestore();
    }
  });

  // ── I1: slot-drift hardening — echo-back + per-slot validation ──────────

  describe('slot echo-back (I1)', () => {
    it('echoes the captured name when asking the next question', async () => {
      const flow = new OnboardingFlow(new OnboardingStore(tmpDir), tmpDir, 'Asia/Kolkata');
      await flow.handle('hello');
      const result = await flow.handle('Arjun Sharma');
      expect(result.response).toContain('Arjun Sharma');
      expect(result.response).toContain('age');
    });

    it('echoes the captured medications before the allergies question', async () => {
      const flow = new OnboardingFlow(new OnboardingStore(tmpDir), tmpDir, 'Asia/Kolkata');
      await flow.handle('hello');
      await flow.handle('Arjun');
      await flow.handle('56');
      await flow.handle('yes');
      await flow.handle('Type 2 diabetes');
      const result = await flow.handle('Metformin 500mg once daily');
      expect(result.response).toContain('Metformin 500mg once daily');
      expect(result.response).toContain('allerg');
    });
  });

  describe('age validation (I1)', () => {
    it('re-asks the age step when the answer has no number', async () => {
      const store = new OnboardingStore(tmpDir);
      const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');
      await flow.handle('hello');
      await flow.handle('Arjun');

      const result = await flow.handle('haan theek hai');

      expect(result.completed).toBeFalsy();
      expect(result.response).toContain('age');
      const state = await store.load();
      expect(state.currentStep).toBe('age');
      expect(state.answers.age).toBeUndefined();
    });

    it('accepts an age with trailing words like "56 saal"', async () => {
      const store = new OnboardingStore(tmpDir);
      const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');
      await flow.handle('hello');
      await flow.handle('Arjun');

      const result = await flow.handle('56 saal');

      expect(result.response).toContain('timezone');
      expect((await store.load()).answers.age).toBe('56 saal');
    });

    it('rejects a nonsensical age number', async () => {
      const store = new OnboardingStore(tmpDir);
      const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');
      await flow.handle('hello');
      await flow.handle('Arjun');

      const result = await flow.handle('999');

      expect(result.response).toContain('age');
      expect((await store.load()).currentStep).toBe('age');
    });
  });

  describe('name validation (I1)', () => {
    it('re-asks the name step for sentence-length garbage', async () => {
      const store = new OnboardingStore(tmpDir);
      const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');
      await flow.handle('hello');

      const garbage = 'please remember I take metformin 500mg twice daily after meals for my sugar problem';
      const result = await flow.handle(garbage);

      expect(result.response).toContain('call you');
      const state = await store.load();
      expect(state.currentStep).toBe('name');
      expect(state.answers.name).toBeUndefined();
    });

    it('accepts a normal two-word name', async () => {
      const store = new OnboardingStore(tmpDir);
      const flow = new OnboardingFlow(store, tmpDir, 'Asia/Kolkata');
      await flow.handle('hello');

      const result = await flow.handle('Rajesh Sharma');

      expect(result.response).toContain('age');
      expect((await store.load()).answers.name).toBe('Rajesh Sharma');
    });
  });
});
