import { checkProviderBindAddresses } from '../../src/security/bind-check';

describe('checkProviderBindAddresses', () => {
  it('warns when provider baseUrl is non-localhost', () => {
    const config = {
      providers: {
        chat: { baseUrl: 'https://api.openai.com/v1' },
      },
    };
    const result = checkProviderBindAddresses(config);
    expect(result.localhostOnly).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('chat provider');
    expect(result.warnings[0]).toContain('not localhost');
  });

  it('passes when all providers use localhost', () => {
    const config = {
      providers: {
        chat: { baseUrl: 'http://localhost:11434' },
        embed: { baseUrl: 'http://127.0.0.1:11434' },
      },
    };
    const result = checkProviderBindAddresses(config);
    expect(result.localhostOnly).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('produces warning for invalid URL', () => {
    const config = {
      providers: {
        bad: { baseUrl: 'not-a-url' },
      },
    };
    const result = checkProviderBindAddresses(config);
    expect(result.localhostOnly).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('invalid baseUrl');
  });

  it('skips providers without baseUrl', () => {
    const config = {
      providers: {
        local: {},
      },
    };
    const result = checkProviderBindAddresses(config);
    expect(result.localhostOnly).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
