// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBackendBaseUrl, getBackendUrl, getWsBaseUrl } from './backendUrl';

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

describe('getBackendBaseUrl', () => {
  it('uses VITE_BACKEND_URL without a trailing slash', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com/');
    expect(getBackendBaseUrl()).toBe('https://api.example.com');
  });

  it('falls back to the page origin (same-origin backend behind nginx)', () => {
    vi.stubEnv('VITE_BACKEND_URL', '');
    expect(getBackendBaseUrl()).toBe(window.location.origin);
  });
});

describe('getWsBaseUrl', () => {
  it('prefers VITE_WS_URL', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.stubEnv('VITE_WS_URL', 'wss://ws.example.com/');
    expect(getWsBaseUrl()).toBe('wss://ws.example.com');
  });

  it('derives ws:// / wss:// from the backend URL', () => {
    vi.stubEnv('VITE_WS_URL', '');
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    expect(getWsBaseUrl()).toBe('wss://api.example.com');
    vi.stubEnv('VITE_BACKEND_URL', 'http://192.168.161.1:3003');
    expect(getWsBaseUrl()).toBe('ws://192.168.161.1:3003');
  });

  it('derives from the page origin when nothing is configured', () => {
    vi.stubEnv('VITE_WS_URL', '');
    vi.stubEnv('VITE_BACKEND_URL', '');
    expect(getWsBaseUrl()).toBe(window.location.origin.replace(/^http/, 'ws'));
  });
});
