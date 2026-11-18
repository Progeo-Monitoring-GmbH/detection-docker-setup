import { describe, expect, it } from 'vitest';
import {
  clearStatusView,
  currentStatusView,
  parseStatusView,
  rangeReaches,
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
