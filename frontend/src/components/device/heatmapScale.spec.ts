import { describe, expect, it } from 'vitest';
import { heatColorAt, heatColorTable } from './heatmapCanvas';
import type { ChartLayout, PlotSensor } from './heatmapChart';
import {
  fieldReading,
  fieldScaleOf,
  formatReading,
  heatNormalization,
  heatReadout,
  readingColor,
  scaleTitle,
  sensorTexter,
  thresholdMarks,
  tickLabeler,
  type FieldScale,
} from './heatmapScale';

const t = (key: string) => `<${key}>`;

const HUMIDITY: FieldScale = {
  range: { min: 40, max: 60 },
  unit: '%',
  decimals: 1,
};

const sensor = (pos: number, series: Array<number | null>): PlotSensor => ({
  pos,
  nx: null,
  ny: null,
  x: 0,
  y: 0,
  xEnd: null,
  yEnd: null,
  series,
  threshold: null,
  name: null,
  device: null,
  label: null,
});

describe('field readings', () => {
  it('maps a grid value (0..1) onto the scale and formats it with its unit', () => {
    expect(fieldReading(HUMIDITY, 0)).toBe(40);
    expect(fieldReading(HUMIDITY, 0.25)).toBe(45);
    expect(formatReading(HUMIDITY, 45)).toBe('45.0 %');
    expect(formatReading({ ...HUMIDITY, unit: '', decimals: 2 }, 3)).toBe(
      '3.00',
    );
  });

  it('spans the readings of every frame in field mode only', () => {
    const sensors = [sensor(1, [41.5, 50]), sensor(2, [null, 58.2])];
    expect(fieldScaleOf(sensors, null, 1)).toBeNull();
    const scale = fieldScaleOf(sensors, '%', 1)!;
    expect(scale).toMatchObject({ unit: '%', decimals: 1 });
    expect(scale.range.min).toBeLessThanOrEqual(41.5);
    expect(scale.range.max).toBeGreaterThanOrEqual(58.2);
  });

  it('falls back to 0..1 without readings', () => {
    expect(fieldScaleOf([sensor(1, [null])], '°C', 1)?.range).toEqual({
      min: 0,
      max: 1,
    });
  });
});

describe('heatNormalization', () => {
  const base = {
    fieldMode: false,
    normalize: false,
    profile: 'diff' as const,
    forceNormalize: false,
  };

  it('scales |WP - EP| against the threshold unless staff normalize', () => {
    expect(heatNormalization(base)).toEqual({
      forced: false,
      normalized: false,
    });
    expect(heatNormalization({ ...base, normalize: true })).toEqual({
      forced: false,
      normalized: true,
    });
  });

  it('always normalizes profiles without a threshold and forced heat', () => {
    expect(heatNormalization({ ...base, profile: 'wp' })).toEqual({
      forced: true,
      normalized: true,
    });
    expect(heatNormalization({ ...base, forceNormalize: true })).toEqual({
      forced: true,
      normalized: true,
    });
  });

  it('never normalizes a field', () => {
    expect(
      heatNormalization({
        ...base,
        fieldMode: true,
        normalize: true,
        profile: 'sum',
      }).normalized,
    ).toBe(false);
  });
});

describe('thresholdMarks', () => {
  const base = {
    absoluteScale: 400,
    threshold: 100,
    profile: 'diff' as const,
    forceNormalize: false,
  };

  it('marks the alarm threshold on the absolute scale of |WP - EP|', () => {
    expect(thresholdMarks(base)).toEqual([0.25]);
  });

  it('marks nothing on a relative scale, without threshold or for other values', () => {
    expect(thresholdMarks({ ...base, absoluteScale: null })).toEqual([]);
    expect(thresholdMarks({ ...base, threshold: null })).toEqual([]);
    expect(thresholdMarks({ ...base, profile: 'ep' })).toEqual([]);
    expect(thresholdMarks({ ...base, forceNormalize: true })).toEqual([]);
  });
});

describe('scaleTitle', () => {
  const base = {
    fieldScale: null,
    heatTitle: undefined,
    profile: 'diff' as const,
    absoluteScale: null,
    t,
  };

  it('prefers the unit, then the given title, then the profile', () => {
    expect(
      scaleTitle({ ...base, fieldScale: HUMIDITY, heatTitle: 'Change' }),
    ).toBe('%');
    expect(scaleTitle({ ...base, heatTitle: 'Change', profile: 'wp' })).toBe(
      'Change',
    );
    expect(scaleTitle({ ...base, profile: 'wp' })).toBe('<heatmap_profile_wp>');
  });

  it('names the absolute scale by its unit, else the heat', () => {
    expect(scaleTitle({ ...base, absoluteScale: 300 })).toBe(
      '<heatmap_scale_unit>',
    );
    expect(scaleTitle(base)).toBe('<heatmap_heat>');
  });
});

describe('tickLabeler', () => {
  it('labels field ticks with readings, absolute ticks with mV, else the heat', () => {
    expect(tickLabeler(HUMIDITY, 300)(0.5)).toBe('50.0');
    expect(tickLabeler(null, 300)(0.5)).toBe('150');
    expect(tickLabeler(null, null)(0.5)).toBe('0.5');
  });
});

describe('heatReadout', () => {
  it('reads a field with its unit, the absolute scale in mV, else the heat', () => {
    expect(
      heatReadout(0.5, { fieldScale: HUMIDITY, absoluteScale: null, t }),
    ).toBe('50.0 %');
    expect(heatReadout(0.5, { fieldScale: null, absoluteScale: 300, t })).toBe(
      '<heatmap_heat> 150 <heatmap_scale_unit>',
    );
    expect(
      heatReadout(0.456, { fieldScale: null, absoluteScale: null, t }),
    ).toBe('<heatmap_heat> 0.46');
  });
});

describe('sensorTexter', () => {
  const layout = {
    sensors: [
      { pos: 3, label: 'Klima Nord', name: 'Nord' },
      { pos: 4, label: null, name: 'Süd' },
      { pos: 5, label: null, name: null },
    ],
  } as unknown as ChartLayout;

  it('names devices in field mode, numbers sensors otherwise', () => {
    const fieldText = sensorTexter(layout, true);
    expect([0, 1, 2].map(fieldText)).toEqual(['Klima Nord', 'Süd', '5']);
    expect([0, 1, 2].map(sensorTexter(layout, false))).toEqual(['3', '4', '5']);
  });
});

describe('readingColor', () => {
  const table = heatColorTable();

  it('colours a reading by its place on the field scale', () => {
    expect(readingColor(table, { min: 40, max: 60 }, 50)).toBe(
      heatColorAt(table, 0.5),
    );
  });

  it('has no colour without a range or for a flat one', () => {
    expect(readingColor(table, undefined, 50)).toBeUndefined();
    expect(readingColor(table, { min: 50, max: 50 }, 50)).toBeUndefined();
  });
});
