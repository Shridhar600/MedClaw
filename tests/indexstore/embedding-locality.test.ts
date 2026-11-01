import { isRemoteEmbeddingBaseUrl } from '../../src/indexstore';

describe('isRemoteEmbeddingBaseUrl', () => {
  it('treats localhost / loopback as local', () => {
    expect(isRemoteEmbeddingBaseUrl('http://localhost:11434/v1')).toBe(false);
    expect(isRemoteEmbeddingBaseUrl('http://127.0.0.1:11434/v1')).toBe(false);
    expect(isRemoteEmbeddingBaseUrl('http://[::1]:11434')).toBe(false);
  });

  it('treats a public / LAN host as remote', () => {
    expect(isRemoteEmbeddingBaseUrl('https://api.openai.com/v1')).toBe(true);
    expect(isRemoteEmbeddingBaseUrl('http://192.168.1.20:11434')).toBe(true);
  });

  it('treats a missing / empty / unparseable URL as local (default Ollama assumption)', () => {
    expect(isRemoteEmbeddingBaseUrl(undefined)).toBe(false);
    expect(isRemoteEmbeddingBaseUrl('')).toBe(false);
    expect(isRemoteEmbeddingBaseUrl('not a url')).toBe(false);
  });
});
