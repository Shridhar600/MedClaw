import { checkProviderBindAddresses } from '../../src/security/bind-check';

describe('checkProviderBindAddresses', () => {
  it('warns when provider baseUrl is non-localhost', () => {
    const config = {
      providers: {
        main: { baseUrl: 'https://api.openai.com/v1' },
      },
    };
    const result = checkProviderBindAddresses(config);
    expect(result.localhostOnly).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('main provider');
    expect(result.warnings[0]).toContain('not localhost');
  });

  it('C09 keeps endpoint credentials, paths and arbitrary provider keys out of warnings', () => {
    const markers = ['C09_user', 'C09_password', 'C09_path', 'C09_query', 'C09_map_key'];
    const result = checkProviderBindAddresses({ providers: {
      main: { baseUrl: `https://${markers[0]}:${markers[1]}@example.invalid/${markers[2]}?token=${markers[3]}` },
      [markers[4]]: { baseUrl: `http://0.0.0.0:11434/${markers[2]}` },
    } });
    expect(result.localhostOnly).toBe(false);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('main provider');
    expect(result.warnings[0]).toContain('not localhost');
    expect(result.warnings[1]).toContain('0.0.0.0');
    for (const marker of markers) expect(result.warnings.join('\n')).not.toContain(marker);
    expect(result.warnings.join('\n')).not.toContain('example.invalid');
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

  it('flags 0.0.0.0 as NOT safe with distinct warning', () => {
    const config = {
      providers: {
        ollama: { baseUrl: 'http://0.0.0.0:11434' },
      },
    };
    const result = checkProviderBindAddresses(config);
    expect(result.localhostOnly).toBe(false);
    expect(result.warnings[0]).toContain('0.0.0.0');
    expect(result.warnings[0]).toContain('NOT localhost');
  });

  it('accepts [::1] as localhost', () => {
    const config = {
      providers: {
        ollama: { baseUrl: 'http://[::1]:11434' },
      },
    };
    const result = checkProviderBindAddresses(config);
    expect(result.localhostOnly).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('accepts 127.x.x.x loopback variations', () => {
    const config = {
      providers: {
        a: { baseUrl: 'http://127.0.0.2:11434' },
        b: { baseUrl: 'http://127.1.2.3:11434' },
      },
    };
    const result = checkProviderBindAddresses(config);
    expect(result.localhostOnly).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
