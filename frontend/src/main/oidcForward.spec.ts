import { describe, expect, it } from 'vitest';
import { oidcForwardUrl, oidcLoginHint } from './oidcForward';

const ORIGIN = 'https://dashboard.progeo.com';
const AUTHORIZE = '/auth/oidc/authorize/?client_id=progeo-matrix&login_hint=kai';

describe('oidcForwardUrl', () => {
  it('accepts the same-origin authorize URL, relative or absolute', () => {
    expect(oidcForwardUrl(AUTHORIZE, ORIGIN)).toBe(`${ORIGIN}${AUTHORIZE}`);
    expect(oidcForwardUrl(`${ORIGIN}${AUTHORIZE}`, ORIGIN)).toBe(`${ORIGIN}${AUTHORIZE}`);
  });

  it('ignores SPA routes and empty forwards', () => {
    expect(oidcForwardUrl('/v1/0/overview', ORIGIN)).toBeNull();
    expect(oidcForwardUrl(null, ORIGIN)).toBeNull();
    expect(oidcForwardUrl('', ORIGIN)).toBeNull();
  });

  it('never leaves the portal', () => {
    expect(oidcForwardUrl(`https://evil.example${AUTHORIZE}`, ORIGIN)).toBeNull();
    expect(oidcForwardUrl(`//evil.example${AUTHORIZE}`, ORIGIN)).toBeNull();
    expect(oidcForwardUrl('/auth/oidc/authorize/../../aadmin/', ORIGIN)).toBeNull();
  });
});

describe('oidcLoginHint', () => {
  it('reads the user name of the chat login link', () => {
    expect(oidcLoginHint(AUTHORIZE, ORIGIN)).toBe('kai');
    expect(oidcLoginHint('/v1/0/overview?login_hint=kai', ORIGIN)).toBe('');
  });
});
