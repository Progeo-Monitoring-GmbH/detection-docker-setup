import { describe, expect, it } from 'vitest';
import {
  defaultStepForRange,
  stepsForRange,
} from '../components/device/heatmapSteps';
import type { VerdachtsstelleCluster } from './locationStatusData';
import {
  anlageColor,
  deviceLabelOf,
  heatmapStepOf,
  kpiSummaryOf,
  liveMeasurementToast,
  openCountOf,
  planFramesOf,
  rangeDaysOf,
  rangeWindow,
  type RequestableDevice,
  requestableDevicesOf,
  zeitreiheOf,
} from './locationStatusViewData';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';

const DAY_MS = 24 * 60 * 60 * 1000;

const cluster = (
  extra: Partial<VerdachtsstelleCluster> = {},
): VerdachtsstelleCluster => ({
  id: 'c1',
  sensor_id: 1,
  device_ids: [],
  device_label: null,
  device_type: null,
  alarm_ids: [],
  state: 'neu',
  active: true,
  severity: 'alarm',
  max_value: null,
  since: null,
  resolved_at: null,
  ack_by: null,
  ack_at: null,
  pending_ack_alarm_ids: [],
  alarms: [],
  ...extra,
});

const device = (extra: Partial<RequestableDevice> = {}): RequestableDevice => ({
  id: 1,
  display_name: null,
  chip_id: 'abc',
  device_ip: '10.0.0.1',
  ...extra,
});

describe('the range', () => {
  it('has its days - "Letzte Messung" goes with the last 24 h', () => {
    expect(rangeDaysOf('7d')).toBe(7);
    expect(rangeDaysOf('1y')).toBe(365);
    expect(rangeDaysOf('latest')).toBe(1);
  });

  it('is the last N days up to now', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(rangeWindow(now, 7, 3600)).toEqual({
      from: now - 7 * DAY_MS,
      to: now,
      step: 3600,
    });
  });
});

describe('the frames of the range', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  // Hourly values of the last 48 h.
  const history: SensorHeatmapResponse = {
    step: 3600,
    timestamps: Array.from({ length: 48 }, (_, i) => (now - (48 - i) * 3600_000) / 1000),
    data: { '1': Array.from({ length: 48 }, (_, i) => i) },
  };

  it('are the ten frames of "Letzte Messung" as loaded', () => {
    expect(planFramesOf(history, true, rangeWindow(now, 1, 3600))).toBe(history);
    expect(zeitreiheOf(history, true, rangeWindow(now, 1, 0), 3600)).toBe(history);
  });

  it("are cut out of the period's history", () => {
    const frames = planFramesOf(history, false, rangeWindow(now, 1, 3600));
    expect(frames?.timestamps.length).toBeGreaterThan(0);
    expect(frames?.timestamps.length).toBeLessThanOrEqual(25);
    expect(Math.max(...(frames?.data['1'] ?? []).map(Number))).toBe(47);

    const series = zeitreiheOf(history, false, rangeWindow(now, 1, 0), 3600);
    expect(series?.timestamps.length).toBeLessThanOrEqual(25);
  });

  it('are none without a history', () => {
    expect(planFramesOf(null, false, rangeWindow(now, 1, 3600))).toBeNull();
    expect(zeitreiheOf(null, false, rangeWindow(now, 1, 0), null)).toBeNull();
  });
});

describe('heatmapStepOf', () => {
  const options = stepsForRange(7, 1800);

  it('keeps the picked step while the range offers it', () => {
    expect(heatmapStepOf(4 * 3600, options, 7, 1800)).toBe(4 * 3600);
  });

  it("falls back to the range's default otherwise", () => {
    const fallback = defaultStepForRange(7, 1800);
    expect(heatmapStepOf(null, options, 7, 1800)).toBe(fallback);
    expect(heatmapStepOf(14 * DAY_MS, options, 7, 1800)).toBe(fallback);
    expect(heatmapStepOf(4 * 3600, [], 7, 1800)).toBe(fallback);
  });
});

describe('the measurement request', () => {
  it('offers only devices with a chip id and an address', () => {
    const ok = device({ id: 1 });
    expect(
      requestableDevicesOf([
        ok,
        device({ id: 2, chip_id: null }),
        device({ id: 3, device_ip: null }),
        device({ id: 4, chip_id: '' }),
      ]),
    ).toEqual([ok]);
    expect(requestableDevicesOf(undefined)).toEqual([]);
    expect(requestableDevicesOf(null)).toEqual([]);
  });

  it('names a device by its full label, else its name, chip id or id', () => {
    expect(deviceLabelOf(device({ label: 'Dach · smartex dm · 1a2b' }))).toBe(
      'Dach · smartex dm · 1a2b',
    );
    expect(deviceLabelOf(device({ label: '', display_name: 'Dach' }))).toBe(
      'Dach',
    );
    expect(deviceLabelOf(device({ chip_id: 'chip-9' }))).toBe('chip-9');
    expect(deviceLabelOf(device({ id: 5, chip_id: null }))).toBe('#5');
  });
});

describe('kpiSummaryOf', () => {
  it('takes the worst open severity, counts the open clusters and the highest reading of all', () => {
    const summary = kpiSummaryOf(
      [
        cluster({ severity: 'beobachten', max_value: 120 }),
        cluster({ severity: 'alarm', max_value: 340 }),
        // Resolved: no severity, not open - but its reading counts.
        cluster({ severity: 'kritisch', state: 'geloest', max_value: 900 }),
      ],
      null,
    );
    expect(summary).toEqual({
      worstSeverity: 'alarm',
      openCount: 2,
      highestReading: 900,
    });
  });

  it('counts the computed points instead when given', () => {
    expect(kpiSummaryOf([cluster()], 0).openCount).toBe(0);
    expect(kpiSummaryOf([], 3).openCount).toBe(3);
  });

  it('is calm without clusters', () => {
    expect(kpiSummaryOf([], null)).toEqual({
      worstSeverity: null,
      openCount: 0,
      highestReading: null,
    });
  });
});

describe('openCountOf', () => {
  it('counts the points not resolved', () => {
    expect(
      openCountOf([{ state: 'neu' }, { state: 'quittiert' }, { state: 'geloest' }]),
    ).toBe(2);
    expect(openCountOf([])).toBe(0);
  });
});

describe('anlageColor', () => {
  it('is green online, red offline, grey otherwise', () => {
    expect(anlageColor('online')).toBe('#3F7A1C');
    expect(anlageColor('offline')).toBe('#C44D26');
    expect(anlageColor('unknown')).toBe('#8B8383');
    expect(anlageColor('loading')).toBe('#8B8383');
  });
});

describe('liveMeasurementToast', () => {
  it('tells how many measurements came - a warning with an alarm', () => {
    expect(liveMeasurementToast({ count: 3, alarm: false })).toEqual({
      key: 'status_live_measurement',
      options: { count: 3 },
      variant: 'info',
    });
    expect(liveMeasurementToast({ count: 1, alarm: true })).toEqual({
      key: 'status_live_measurement_alarm',
      options: { count: 1 },
      variant: 'warning',
    });
  });

  it('just tells new data when the count is unknown', () => {
    expect(liveMeasurementToast({ count: null, alarm: false })).toEqual({
      key: 'status_live_measurement_new',
      variant: 'info',
    });
    expect(liveMeasurementToast({ count: null, alarm: true }).variant).toBe(
      'warning',
    );
  });
});
