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
});
