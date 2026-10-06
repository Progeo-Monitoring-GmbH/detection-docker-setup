// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONSENT_MAX_AGE_MS,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  readConsent,
  writeConsent,
} from './consent';

beforeEach(() => {
  localStorage.clear();
});

describe('consent storage', () => {
  it('returns null when nothing is stored', () => {
    expect(readConsent()).toBeNull();
  });

  it('round-trips a decision', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    writeConsent({ externalMaps: true }, now);

    expect(readConsent(now.getTime())).toEqual({
      version: CONSENT_VERSION,
      decidedAt: now.toISOString(),
      categories: { necessary: true, externalMaps: true },
    });
  });

  it('expires a decision older than the max age', () => {
    const decidedAt = new Date('2025-01-01T00:00:00Z');
    writeConsent({ externalMaps: false }, decidedAt);

    expect(
      readConsent(decidedAt.getTime() + CONSENT_MAX_AGE_MS - 1),
    ).not.toBeNull();
    expect(
      readConsent(decidedAt.getTime() + CONSENT_MAX_AGE_MS + 1),
    ).toBeNull();
  });

  it('discards decisions from an older consent version', () => {
    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({
        version: CONSENT_VERSION - 1,
        decidedAt: new Date().toISOString(),
        categories: { necessary: true, externalMaps: true },
      }),
    );

    expect(readConsent()).toBeNull();
  });

  it('ignores malformed storage content', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, '{not json');
    expect(readConsent()).toBeNull();

    localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({
        version: CONSENT_VERSION,
        decidedAt: 'yesterday',
        categories: {},
      }),
    );
    expect(readConsent()).toBeNull();
  });
});
