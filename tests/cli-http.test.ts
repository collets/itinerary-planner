import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../scripts/api-client';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('protected CLI transport', () => {
  it('sends separate application and deployment credentials to the exact configured HTTPS API only', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const client = apiClient('https://preview.example.test', 'application-token', 'preview-bypass');
    await client.fetch('/api/v2/ai/admin/status');
    const [url, options] = fetch.mock.calls[0];
    expect(url.href).toBe('https://preview.example.test/api/v2/ai/admin/status');
    expect(options.headers.get('Authorization')).toBe('Bearer application-token');
    expect(options.headers.get('x-vercel-protection-bypass')).toBe('preview-bypass');
    expect(options.redirect).toBe('error');
    for (const path of [
      'https://evil.example/api/v2/trips',
      '//evil.example/api/v2/trips',
      '/api/v1/trips',
      '/api/v2/trips?token=secret',
      '/api/v2/trips#secret',
      '/api/v2/../../outside',
    ])
      expect(() => client.fetch(path)).toThrow('configured API origin');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    'http://remote.example',
    'https://user:secret@example.test',
    'https://example.test?token=secret',
    'https://example.test/private',
    'not a URL',
  ])('rejects unsafe origins without echoing credentials: %s', (address) => {
    expect(() => apiClient(address, 'token')).toThrow();
    try {
      apiClient(address, 'token');
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
  it('allows ordinary local use, rejects local bypass secrets and retains authentication requirements', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await apiClient('http://localhost:5173', 'local-token').fetch('/api/v2/trips');
    expect(fetch.mock.calls[0][1].headers.has('x-vercel-protection-bypass')).toBe(false);
    expect(() => apiClient('http://localhost:5173', 'token', 'bypass')).toThrow('HTTPS');
    expect(() =>
      apiClient('https://preview.example.test', undefined).fetch('/api/v2/trips'),
    ).toThrow('credential');
  });
});
