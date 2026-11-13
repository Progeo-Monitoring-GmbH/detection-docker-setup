// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConsent } from '../components/privacy/consent';
import {
  clickTarget,
  createActivityTracker,
  FLUSH_MS,
  MAX_BATCH,
  normalizePath,
  shouldTrack,
  startsNewSession,
  type ActivityBatch,
} from './activityTracker';

/** An unsigned JWT - jwtDecode doesn't check the signature. */
const jwt = (claims: object) =>
  `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.sig`;

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

const html = (markup: string) => {
  document.body.innerHTML = markup;
};

describe('normalizePath', () => {
  it.each([
    ['/location/12/analyse', '/location/:id/analyse'],
    ['/location/12/analyse?from=3#top', '/location/:id/analyse'],
    ['/login/link/abc', '/login/link/:token'],
    ['/passwort/neu/x-y_z', '/passwort/neu/:token'],
    ['/zugang/bestaetigen/abc', '/zugang/bestaetigen/:token'],
    ['/demo/login/abc', '/demo/login/:token'],
    ['/device/0a1b2c3d4e5f6a7b8c9d/update/', '/device/:token/update/'],
    ['/backup/1/overview/', '/backup/:id/overview/'],
    ['/device/statistics/', '/device/statistics/'],
    ['/', '/'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizePath(raw)).toBe(expected);
  });
});

describe('clickTarget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('takes the test id of the clicked control', () => {
    html('<button data-testid="alarms-export"><span id="inner">Max Mustermann</span></button>');
    expect(clickTarget(document.getElementById('inner'))).toBe('alarms-export');
  });

  it('takes the closest ancestor test id of a control without one', () => {
    html('<div data-testid="topbar-menu"><a href="/x" id="link">Name</a></div>');
    expect(clickTarget(document.getElementById('link'))).toBe('topbar-menu');
  });

  it('falls back to the tag name - never the text', () => {
    html('<button id="b">Max Mustermann</button><input type="checkbox" id="c">');
    expect(clickTarget(document.getElementById('b'))).toBe('button');
    expect(clickTarget(document.getElementById('c'))).toBe('input');
  });

  it('counts role=button and select, not plain text or text inputs', () => {
    html(
      '<div role="button" data-testid="tile" id="r"></div><select id="s"></select>' +
        '<p data-testid="text" id="p">x</p><input type="text" data-testid="field" id="t">',
    );
    expect(clickTarget(document.getElementById('r'))).toBe('tile');
    expect(clickTarget(document.getElementById('s'))).toBe('select');
    expect(clickTarget(document.getElementById('p'))).toBeNull();
    expect(clickTarget(document.getElementById('t'))).toBeNull();
  });

  it('ignores test ids that are not test ids', () => {
    html('<button data-testid="row Max Mustermann" id="b"></button>');
    expect(clickTarget(document.getElementById('b'))).toBe('button');
  });
});

describe('shouldTrack', () => {
  const gate = { loggedIn: true, flag: true, consent: true, staffAccount: false, impersonated: false };

  it('tracks a consenting normal user with the backend flag', () => {
    expect(shouldTrack(gate)).toBe(true);
  });

  it.each([
    ['no backend flag', { flag: false }],
    ['no consent', { consent: false }],
    ['logged out', { loggedIn: false }],
    ['a staff account viewing as normal user', { staffAccount: true }],
    ['a superuser logged in as the user', { impersonated: true }],
  ])('does not track with %s', (_, change) => {
    expect(shouldTrack({ ...gate, ...change })).toBe(false);
  });
});

describe('startsNewSession', () => {
  const now = Date.UTC(2026, 10, 13, 12);
  const valid = (claims: object) => jwt({ exp: now / 1000 + 600, ...claims });

  it('is a login without a (valid) previous session or for another user', () => {
    expect(startsNewSession('', valid({ user_id: 1 }), now)).toBe(true);
    expect(startsNewSession(jwt({ user_id: 1, exp: now / 1000 - 1 }), valid({ user_id: 1 }), now)).toBe(true);
    expect(startsNewSession(valid({ user_id: 2 }), valid({ user_id: 1 }), now)).toBe(true);
  });

  it('is no login for a token swap or "log in as" and back', () => {
    expect(startsNewSession(valid({ user_id: 1 }), valid({ user_id: 1 }), now)).toBe(false);
    expect(startsNewSession(valid({ user_id: 9 }), valid({ user_id: 1, impersonator: 'boss' }), now)).toBe(false);
    expect(startsNewSession(valid({ user_id: 1, impersonator: 'boss' }), valid({ user_id: 9 }), now)).toBe(false);
  });
});

describe('createActivityTracker', () => {
  let sent: ActivityBatch[];
  let created: ReturnType<typeof createActivityTracker>[] = [];
  const events = () => sent.flatMap((batch) => batch.events);
  const tracker = () => {
    const activity = createActivityTracker({ send: (batch) => sent.push(batch) });
    created.push(activity);
    return activity;
  };

  beforeEach(() => {
    sent = [];
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
    setVisibility('visible');
    html('<button data-testid="alarms-export" id="b"></button>');
  });

  afterEach(() => {
    // Their listeners would count the clicks of the next test.
    created.forEach((activity) => activity.setActive(false));
    created = [];
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('sends nothing while it is off', () => {
    writeConsent({ externalMaps: false, statistics: true });
    const activity = tracker();
    activity.pageChanged('/alarms/');
    activity.markLogin('/login');
    document.getElementById('b')!.click();
    vi.advanceTimersByTime(FLUSH_MS * 3);
    activity.pageChanged('/map/');
    window.dispatchEvent(new Event('pagehide'));

    expect(sent).toEqual([]);
  });

  it('records page views, clicks and flushes every FLUSH_MS', () => {
    const activity = tracker();
    activity.pageChanged('/location/7/analyse');
    activity.setActive(true);
    vi.advanceTimersByTime(4000);
    document.getElementById('b')!.click();
    activity.pageChanged('/alarms/');

    expect(sent).toEqual([]);
    vi.advanceTimersByTime(FLUSH_MS);

    expect(events()).toEqual([
      { kind: 'click', path: '/location/:id/analyse', target: 'alarms-export', at: Date.parse('2026-11-13T10:00:04Z') },
      { kind: 'page', path: '/location/:id/analyse', duration_ms: 4000, at: Date.parse('2026-11-13T10:00:00Z') },
    ]);
    expect(sent[0].session).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('leaves the hidden time out of the duration', () => {
    const activity = tracker();
    activity.pageChanged('/alarms/');
    activity.setActive(true);
    vi.advanceTimersByTime(3000);
    setVisibility('hidden');
    vi.advanceTimersByTime(60_000);
    setVisibility('visible');
    vi.advanceTimersByTime(2000);
    window.dispatchEvent(new Event('pagehide'));

    expect(events()).toEqual([
      { kind: 'page', path: '/alarms/', duration_ms: 5000, at: Date.parse('2026-11-13T10:00:00Z') },
    ]);
  });

  it('flushes when the tab is hidden', () => {
    const activity = tracker();
    activity.setActive(true);
    document.getElementById('b')!.click();
    setVisibility('hidden');

    expect(events().map((event) => event.kind)).toEqual(['click']);
  });

  it('drops everything and stops when switched off (consent withdrawn)', () => {
    const activity = tracker();
    activity.setActive(true);
    document.getElementById('b')!.click();
    activity.setActive(false);
    document.getElementById('b')!.click();
    vi.advanceTimersByTime(FLUSH_MS * 2);
    window.dispatchEvent(new Event('pagehide'));

    expect(sent).toEqual([]);
  });

  it('sends a login once it is on - only with consent', () => {
    const withoutConsent = tracker();
    withoutConsent.markLogin('/login');
    withoutConsent.setActive(true);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(events().filter((event) => event.kind === 'login')).toEqual([]);
    withoutConsent.setActive(false);

    writeConsent({ externalMaps: false, statistics: true });
    const activity = tracker();
    activity.markLogin('/login/link/abcdef');
    vi.advanceTimersByTime(1000);
    activity.setActive(true);
    vi.advanceTimersByTime(FLUSH_MS);

    expect(events().filter((event) => event.kind === 'login')).toEqual([
      { kind: 'login', path: '/login/link/:token', at: Date.parse('2026-11-13T10:00:15Z') },
    ]);
  });

  it(`sends at most ${MAX_BATCH} events per request`, () => {
    const activity = tracker();
    activity.setActive(true);
    for (let index = 0; index < MAX_BATCH + 5; index += 1) {
      document.getElementById('b')!.click();
    }
    vi.advanceTimersByTime(FLUSH_MS);

    expect(sent.map((batch) => batch.events.length)).toEqual([MAX_BATCH, 5]);
  });
});
