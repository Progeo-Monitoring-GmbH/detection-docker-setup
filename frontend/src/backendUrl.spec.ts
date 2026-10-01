// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBackendUrl } from './backendUrl';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getBackendUrl', () => {
  it('passes absolute http/https URLs through unchanged (case-insensitive scheme)', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    expect(getBackendUrl('http://cdn.example.com/a.png')).toBe('http://cdn.example.com/a.png');
    expect(getBackendUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(getBackendUrl('HTTPS://CDN.example.com/a.png')).toBe('HTTPS://CDN.example.com/a.png');
  });

  it('joins the backend URL and a path with exactly one slash', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    expect(getBackendUrl('media/x.png')).toBe('https://api.example.com/media/x.png');
    expect(getBackendUrl('/media/x.png')).toBe('https://api.example.com/media/x.png');
  });

  it('strips a trailing slash from the backend URL', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com/');
    expect(getBackendUrl('/media/x.png')).toBe('https://api.example.com/media/x.png');
    expect(getBackendUrl('media/x.png')).toBe('https://api.example.com/media/x.png');
  });

  it('keeps a path prefix of the backend URL', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://example.com/backend/');
    expect(getBackendUrl('/v1/file/1')).toBe('https://example.com/backend/v1/file/1');
  });

  it('falls back to window.location.origin when no backend URL is configured', () => {
    vi.stubEnv('VITE_BACKEND_URL', '');
    expect(getBackendUrl('/media/x.png')).toBe(`${window.location.origin}/media/x.png`);
    expect(getBackendUrl('media/x.png')).toBe(`${window.location.origin}/media/x.png`);
  });

  it('does not treat paths that merely start with "http" as absolute', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    expect(getBackendUrl('http-files/x')).toBe('https://api.example.com/http-files/x');
  });
});
