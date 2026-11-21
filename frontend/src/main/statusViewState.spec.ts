import { describe, expect, it } from 'vitest';
import {
  clearStatusView,
  currentStatusView,
  parseStatusView,
  rangeForMoment,
  rangeReaches,
  requestedSettings,
  statusViewPath,
  updateStatusView,
  type StatusViewState,
} from './statusViewState';

const full: StatusViewState = {
  view: 'zeitreihe',
  range: '30d',
  step: 7200,
  at: '2026-11-17T08:00:00.000Z',
  sensor: 3,
  sensors: ['sensor-3', '4:0'],
  profile: 'wp',
};

describe('the quick link', () => {
  it('opens the status page with every setting - and reads them back', () => {
    const path = statusViewPath(12, full);

    expect(path.startsWith('/location/12/status?')).toBe(true);
    const params = new URL(path, 'https://portal.progeo.com').searchParams;
    const { at, ...rest } = full;
    // `at` is read by the page itself (parseStatusAt).
    expect(params.get('at')).toBe(at);
    expect(parseStatusView(params)).toEqual(rest);
  });

  it('is the plain status page without a view', () => {
    expect(statusViewPath(12, null)).toBe('/location/12/status');
  });

  it('leaves out what is not valid', () => {
    const params = new URLSearchParams(
      'view=map&range=5d&step=-3&sensor=x&sensors=sensor-1,evil;drop,2:1&profile=max',
    );

    expect(parseStatusView(params)).toEqual({ sensors: ['sensor-1', '2:1'] });
  });
});

describe('the open status page', () => {
  it('keeps what the view uses - the frame on the roof view, the sensors on the Zeitreihe', () => {
    updateStatusView(7, { ...full, view: 'roof' });
    expect(currentStatusView(7)).toEqual({
      view: 'roof',
      range: '30d',
      step: 7200,
      at: full.at,
      sensor: 3,
      profile: 'wp',
    });

    updateStatusView(7, { view: 'zeitreihe', step: undefined });
    expect(currentStatusView(7)).toEqual({
      view: 'zeitreihe',
      range: '30d',
      sensor: 3,
      sensors: full.sensors,
      profile: 'wp',
    });
  });

  it('belongs to its location and ends when the page is left', () => {
    updateStatusView(7, { view: 'roof', range: '7d' });

    expect(currentStatusView(8)).toBeNull();
    clearStatusView(8);
    expect(currentStatusView(7)).not.toBeNull();
    clearStatusView(7);
    expect(currentStatusView(7)).toBeNull();
  });
});

describe('rangeReaches', () => {
  it('tells whether the last N days still reach back to a moment', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');

    expect(rangeReaches('7d', Date.parse('2026-11-15T12:00:00Z'), now)).toBe(
      true,
    );
    expect(rangeReaches('7d', Date.parse('2026-11-10T12:00:00Z'), now)).toBe(
      false,
    );
  });
});

describe('"Letzte Messung" (range=latest)', () => {
  it('is kept in the URL and read back', () => {
    const params = new URLSearchParams('range=latest&view=roof');
    expect(parseStatusView(params).range).toBe('latest');
    expect(parseStatusView(new URLSearchParams('range=latests')).range).toBeUndefined();
  });

  it('reaches back to no moment - a ?at= link picks a period', () => {
    const now = Date.now();
    expect(rangeReaches('latest', now - 1_000, now)).toBe(false);
    expect(rangeReaches('24h', now - 1_000, now)).toBe(true);
  });
});

describe('requestedSettings (the URL applied on the page)', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const candidates = ['24h', '7d', '30d', '1y'] as const;
  const settings = (
    requested: Parameters<typeof requestedSettings>[0],
    at: number | null,
    { staff = false, ranges = candidates as readonly ('24h' | '7d' | '30d' | '1y')[] } = {},
  ) => requestedSettings(requested, at, now, ranges, staff);

  it('takes what is asked for without a moment', () => {
    expect(
      settings({ view: 'zeitreihe', range: '30d', step: 7200, sensor: 3 }, null),
    ).toEqual({ view: 'zeitreihe', range: '30d', step: 7200, sensor: 3 });
    expect(settings({}, null)).toEqual({});
  });

  it('takes the heat profile for staff only', () => {
    expect(settings({ profile: 'wp' }, null).profile).toBeUndefined();
    expect(settings({ profile: 'wp' }, null, { staff: true }).profile).toBe('wp');
  });

  it('keeps range and step while the range reaches back to the moment', () => {
    const at = Date.parse('2026-11-15T12:00:00Z');
    expect(settings({ range: '7d', step: 3600 }, at)).toEqual({
      range: '7d',
      step: 3600,
    });
  });

  it('picks the shortest range reaching the moment - its default step, the roof view', () => {
    const at = Date.parse('2026-11-01T12:00:00Z');
    expect(settings({ range: '7d', step: 3600 }, at)).toEqual({
      view: 'roof',
      range: '30d',
      step: null,
    });
    expect(settings({}, at)).toEqual({ view: 'roof', range: '30d', step: null });
  });

  it('keeps a requested view', () => {
    const at = Date.parse('2026-11-01T12:00:00Z');
    expect(settings({ view: 'zeitreihe', range: 'latest' }, at)).toEqual({
      view: 'zeitreihe',
      range: '30d',
      step: null,
    });
  });

  it('changes no range without candidates', () => {
    const at = Date.parse('2026-11-01T12:00:00Z');
    expect(settings({}, at, { ranges: [] })).toEqual({ view: 'roof' });
  });
});

describe('rangeForMoment ("Erstes Auftreten anzeigen")', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');

  it('stays while the range reaches back to the moment', () => {
    expect(
      rangeForMoment('7d', Date.parse('2026-11-15T12:00:00Z'), now, ['24h', '7d', '30d']),
    ).toBeNull();
  });

  it('switches to the shortest offered range that does', () => {
    expect(
      rangeForMoment('7d', Date.parse('2026-11-01T12:00:00Z'), now, ['24h', '7d', '30d']),
    ).toBe('30d');
    expect(
      rangeForMoment('latest', now - 60_000, now, ['24h', '7d']),
    ).toBe('24h');
  });
});
