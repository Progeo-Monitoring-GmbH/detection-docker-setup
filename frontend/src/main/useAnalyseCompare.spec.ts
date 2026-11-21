import { describe, expect, it } from 'vitest';
import { compareUrls } from './useAnalyseCompare';

describe('compareUrls', () => {
  const query = {
    locationId: 5,
    days: 7,
    resolution: 300,
    heatProfile: 'wp' as const,
    shownDevice: 3,
    heatNoiseQuery: '&raw=1',
    planQuery: '&lageplan=9',
    rawQuery: '&raw=1',
  };

  it('asks for the same period, ending the offset ago', () => {
    const now = Date.parse('2026-11-21T00:00:00Z');
    const to = encodeURIComponent('2026-11-14T00:00:00.000Z');
    expect(compareUrls(query, 7, now)).toEqual({
      heatmap: `/v1/location/5/heatmap/?days=7&limit=300&to=${to}&lageplan=9&profile=wp&raw=1`,
      measurements: `/v1/location/5/measurements/?days=7&limit=300&to=${to}&device=3&raw=1`,
    });
  });

  it('leaves out the default profile and device', () => {
    const urls = compareUrls(
      {
        ...query,
        heatProfile: 'diff',
        shownDevice: null,
        heatNoiseQuery: '',
        planQuery: '',
        rawQuery: '',
      },
      1,
      0,
    );
    expect(urls.heatmap).not.toContain('profile=');
    expect(urls.measurements).not.toContain('device=');
  });
});
