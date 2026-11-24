import { describe, expect, it } from 'vitest';
import { defaultDeviceRanges, type MeasurePoint, type WizardDevice } from './lageplanWizardUtils';

/** Points `from`..`to` (sensor_order) connected to `device`. */
const points = (device: number | null, from: number, to: number): MeasurePoint[] =>
  Array.from({ length: to - from + 1 }, (_, index) => ({
    id: from + index,
    sensor_order: from + index,
    device,
  }));

const device = (id: number, extra: Partial<WizardDevice> = {}): WizardDevice => ({
  id,
  first_sensor_order: 1,
  sensor_count: null,
  ...extra,
});

describe('defaultDeviceRanges', () => {
  it("gives each device the range of its points, the last one open-ended", () => {
    const ranges = defaultDeviceRanges(
      [...points(1, 1, 100), ...points(2, 101, 200)],
      [device(1), device(2, { first_sensor_order: 101 })],
    );

    expect(ranges).toEqual([
      { deviceId: 1, from: '1', to: '100' },
      { deviceId: 2, from: '101', to: '' },
    ]);
  });

  it('keeps a saved range without points yet - a third device added in step 2', () => {
    const ranges = defaultDeviceRanges(
      [...points(1, 1, 100), ...points(2, 101, 200)],
      [device(1), device(2, { first_sensor_order: 101 }), device(3, { first_sensor_order: 201 })],
    );

    expect(ranges).toEqual([
      { deviceId: 1, from: '1', to: '100' },
      { deviceId: 2, from: '101', to: '200' },
      { deviceId: 3, from: '201', to: '' },
    ]);
  });

  it("ends a range without points at its saved sensor count", () => {
    const ranges = defaultDeviceRanges(
      points(1, 1, 100),
      [device(1), device(3, { first_sensor_order: 201, sensor_count: 50 })],
    );

    expect(ranges).toEqual([
      { deviceId: 1, from: '1', to: '100' },
      { deviceId: 3, from: '201', to: '250' },
    ]);
  });

  it('keeps a saved range that covers a single point', () => {
    const ranges = defaultDeviceRanges(
      [...points(1, 1, 200), ...points(3, 201, 201)],
      [device(1), device(3, { first_sensor_order: 201 })],
    );

    expect(ranges).toEqual([
      { deviceId: 1, from: '1', to: '200' },
      { deviceId: 3, from: '201', to: '' },
    ]);
  });

  it('leaves out hand-placed sensors (one point each, counted from 1)', () => {
    const ranges = defaultDeviceRanges(
      [...points(1, 1, 100), ...points(7, 101, 101), ...points(8, 102, 102)],
      [device(1), device(7), device(8)],
    );

    expect(ranges).toEqual([{ deviceId: 1, from: '1', to: '' }]);
  });

  it('gives a single device all sensors, and several devices without ranges none', () => {
    expect(defaultDeviceRanges([], [device(1)])).toEqual([{ deviceId: 1, from: '1', to: '' }]);
    expect(defaultDeviceRanges([], [device(1), device(2)])).toEqual([]);
  });
});
