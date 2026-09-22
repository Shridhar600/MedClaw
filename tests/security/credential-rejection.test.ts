import { contentContainsCredentials } from '../../src/security/credential-rejection';

describe('contentContainsCredentials', () => {
  it('rejects OpenAI sk- key', () => {
    const content = 'My API key is sk-abc123def456ghi789jkl012mno345pqr678';
    const result = contentContainsCredentials(content);
    expect(result.matched).toBe(true);
    expect(result.pattern).toContain('sk-');
  });

  it('rejects GitHub PAT', () => {
    const content = 'ghp_abc123def456ghi789jkl012mno345pqr678stuv';
    const result = contentContainsCredentials(content);
    expect(result.matched).toBe(true);
  });

  it('allows normal health note', () => {
    const content = 'Took 500mg paracetamol at 8am. Blood pressure 120/80.';
    const result = contentContainsCredentials(content);
    expect(result.matched).toBe(false);
    expect(result.pattern).toBe('');
  });

  it('rejects private key block', () => {
    const content = `Some text
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0gLk3
-----END RSA PRIVATE KEY-----
more text`;
    const result = contentContainsCredentials(content);
    expect(result.matched).toBe(true);
    expect(result.pattern).toContain('BEGIN');
  });

  it('rejects API key pattern with apikey label', () => {
    const content = 'apikey = "abcdefghijklmnopqrstuvwxyz123456"';
    const result = contentContainsCredentials(content);
    expect(result.matched).toBe(true);
  });

  it('rejects Slack token pattern', () => {
    const content = 'slack token: xoxb-1234567890-abcdefghijklmnopqrstuvwxyz';
    const result = contentContainsCredentials(content);
    expect(result.matched).toBe(true);
  });

  it('allows real medical note with NDC/ICD-10 codes', () => {
    const content = 'Patient presents with type 2 diabetes. NDC 0093-7146-56, ICD-10 E11.9, take metformin 500mg twice daily with meals.';
    const result = contentContainsCredentials(content);
    expect(result.matched).toBe(false);
  });

  // SEC-M2a: a Cyrillic-homoglyph label must not bypass the scanner. The label
  // 'аpi_key' (with Cyrillic а, U+0430) is visually identical to 'api_key' but
  // ASCII-only — so the original regex missed it. Normalize lookalikes to ASCII
  // before scanning.
  it('rejects a Cyrillic-homoglyph label (аpi_key) by normalizing to ASCII before scanning', () => {
    // 'а' below is Cyrillic small a (U+0430), NOT Latin a.
    const content = 'аpi_key = abcdefghijklmnopqrstuvwxyz123456';
    expect(content.charCodeAt(0)).toBe(0x0430); // sanity: really Cyrillic
    const result = contentContainsCredentials(content);
    expect(result.matched).toBe(true);
  });

  // SEC-M2b (scanner side): a label and a value separated by >8192 chars of
  // non-alphanumeric padding must still be detected when the assembled file is
  // scanned as a whole.
  it('rejects a label and value separated by >8192 chars of padding when scanned as one assembled blob', () => {
    const content = 'api_key = ' + '#'.repeat(8200) + 'abcdefghijklmnopqrstuvwxyz123456';
    expect(content.length).toBeGreaterThan(8210);
    const result = contentContainsCredentials(content);
    expect(result.matched).toBe(true);
  });

  it.each([
    ['U+200B ZERO WIDTH SPACE', '\u200b'],
    ['U+200C ZERO WIDTH NON-JOINER', '\u200c'],
    ['U+200D ZERO WIDTH JOINER', '\u200d'],
    ['U+2060 WORD JOINER', '\u2060'],
    ['U+FEFF ZERO WIDTH NO-BREAK SPACE', '\ufeff'],
    ['U+00AD SOFT HYPHEN', '\u00ad'],
    ['U+180E MONGOLIAN VOWEL SEPARATOR', '\u180e'],
    ['U+FE0F VARIATION SELECTOR-16', '\ufe0f'],
  ])('rejects a credential split by %s', (_label, invisible) => {
    const content = `sk${invisible}-abc123def456ghi789jkl012mno345pqr678`;
    expect(contentContainsCredentials(content).matched).toBe(true);
  });
});
