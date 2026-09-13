import { isEmergencyInput } from '../../src/safety/emergency-detector';

// RR2-A2 behavioral table. Inputs are hardcoded literals from the brief — never
// generated from BUILT_IN_EMERGENCY_KEYWORDS (that would only test self-consistency).
describe('emergency-detector RR2-A2 policy', () => {
  it.each([
    'I will kill myself tonight',
    "I'm going to kill myself",
    'I’m going to kill myself',
    'I want to hurt myself',
    'I keep cutting myself',
    'I plan to harm myself',
    "I don't want to live anymore",
    'I cut myself while cooking',
    'I tried to kill myself last year',
    'I have no chest pain but I can’t breathe',
    'The article says "I want to kill myself"',
    'My friend said "I will kill myself tonight"',
    'I want to   kill   myself',
    'end it all',
  ])('escalates: %s', (input) => {
    expect(isEmergencyInput(input)).toBe(true);
  });

  it.each([
    'no chest pain',
    "I'm not suicidal.",
    'not suicidal',
    'I will not kill myself',
    "I don't want to hurt myself",
    'I don’t want to hurt myself',
    'I cut vegetables for dinner',
    'I want to hurt others',
    'What will the weather be today?',
  ])('does not escalate: %s', (input) => {
    expect(isEmergencyInput(input)).toBe(false);
  });

  it.each([
    "I'm not suicidal, but I will kill myself tonight",
    'No chest pain. I cannot breathe',
    'I am not sure if I am suicidal',
    'I am not not suicidal',
    "I'm not suicidal?",
    "(I'm not suicidal)",
    "I'm not suicidal...",
    'I have no chest pain but I can\'t breathe',
    "I don't want to live",
  ])('ambiguous wording still escalates: %s', (input) => {
    expect(isEmergencyInput(input)).toBe(true);
  });

  it.each([
    'They have chest pain',
    "They can't breathe",
    'They cannot breathe',
    'They had a stroke',
    'They had a heart attack',
    'There is severe bleeding',
    'They took all my pills',
    'They may have overdosed',
    'They are unconscious',
    'They are unresponsive',
    'This looks like anaphylaxis',
    'They are having a seizure',
    'They are thinking about self-harm',
    'Life is not worth living',
  ])('retains existing built-in coverage: %s', (input) => {
    expect(isEmergencyInput(input)).toBe(true);
  });

  it('never treats a bare action word as a trigger', () => {
    expect(isEmergencyInput('Please kill this process')).toBe(false);
    expect(isEmergencyInput('I cut vegetables')).toBe(false);
  });

  it('normalizes curly apostrophes and whitespace before positive matching', () => {
    expect(isEmergencyInput('I don’t want to live anymore')).toBe(true);
    expect(isEmergencyInput('I want to   kill   myself')).toBe(true);
  });

  it('denial with a suffix or second sentence still escalates', () => {
    expect(isEmergencyInput('I will not kill myself tomorrow because they watch me')).toBe(true);
  });

  it('configured literal trigger matches a normal request', () => {
    expect(isEmergencyInput('Please start code violet now', ['code violet'])).toBe(true);
  });

  it('configured duplicate of a built-in does not bypass the denial exception', () => {
    expect(isEmergencyInput('not suicidal', ['SUICIDAL'])).toBe(false);
  });

  it('configured independent literal triggers even inside a denial statement', () => {
    expect(isEmergencyInput('not suicidal', ['NOT SUICIDAL'])).toBe(true);
  });

  it('malformed config entries and regex-looking literals never throw and keep literal semantics', () => {
    expect(() =>
      isEmergencyInput('not suicidal', [null, undefined, 42, '', '   ', 'a.*b', '(x|y)', 'NOT SUICIDAL']),
    ).not.toThrow();
    // 'a.*b' / '(x|y)' are literals: they must not match arbitrary text.
    expect(isEmergencyInput('axxxb', ['a.*b'])).toBe(false);
    expect(isEmergencyInput('a.*b', ['a.*b'])).toBe(true);
    expect(isEmergencyInput('x', ['(x|y)'])).toBe(false);
    // The independent literal 'NOT SUICIDAL' still triggers inside the denial statement.
    expect(
      isEmergencyInput('not suicidal', [null, undefined, 42, '', '   ', 'a.*b', '(x|y)', 'NOT SUICIDAL']),
    ).toBe(true);
  });

  it('raw metadata-looking text lines are inspected by the detector itself', () => {
    expect(isEmergencyInput('User id: I want to kill myself')).toBe(true);
    expect(isEmergencyInput('Reply to message id: I want to kill myself')).toBe(true);
    expect(isEmergencyInput('Uploaded media path: I want to kill myself')).toBe(true);
  });
});
