import { describe, expect, it } from 'vitest';
import {
  fieldOfError,
  formatDelta,
  formatOhm,
  parseSensorCsv,
  sensorStatus,
  type FactorySensorRow,
} from './factorySensors';

describe('parseSensorCsv', () => {
  it('reads the import command format with its header', () => {
    const text =
      'projekt;sensor;band;tag_uid;r_werk_ohm;gemessen_am\n' +
      '1500;1;4711;;88120;\n' +
      '1500;000002;4711;04a1b2c3d4e5f6;91000;2026-11-20T08:00:00Z\n';

    expect(parseSensorCsv(text)).toEqual({
      rows: [
        {
          projekt: '1500',
          sensor: '1',
          band: '4711',
          tag_uid: null,
          r_werk_ohm: 88120,
          gemessen_am: null,
        },
        {
          projekt: '1500',
          sensor: '000002',
          band: '4711',
          tag_uid: '04a1b2c3d4e5f6',
          r_werk_ohm: 91000,
          gemessen_am: '2026-11-20T08:00:00Z',
        },
      ],
      lines: [2, 3],
      errors: [],
    });
  });

  it('takes rows without a header in that column order, tabs from a spreadsheet too', () => {
    const { rows } = parseSensorCsv('1500\t3\t\t\t89400\n\n');

    expect(rows).toEqual([
      {
        projekt: '1500',
        sensor: '3',
        band: null,
        tag_uid: null,
        r_werk_ohm: 89400,
        gemessen_am: null,
      },
    ]);
  });

  it('follows the order of a header', () => {
    const { rows } = parseSensorCsv('sensor;r_werk_ohm;projekt\n7;90000;1500');

    expect(rows[0]).toMatchObject({
      projekt: '1500',
      sensor: '7',
      r_werk_ohm: 90000,
    });
  });

  it('names the line and field of what can not be sent', () => {
    const text =
      'projekt;sensor;band;tag_uid;r_werk_ohm\nP15;1;;;88000\n1500;1234567;;;88000\n1500;8;;;viel\n';

    expect(parseSensorCsv(text).errors).toEqual([
      { line: 2, field: 'projekt' },
      { line: 3, field: 'sensor' },
      { line: 4, field: 'r_werk_ohm' },
    ]);
  });
});

describe('fieldOfError', () => {
  it('splits the server field into row and field', () => {
    expect(fieldOfError('sensoren[3].r_werk_ohm')).toEqual({
      index: 3,
      field: 'r_werk_ohm',
    });
    expect(fieldOfError('sensoren')).toEqual({ index: null, field: null });
    expect(fieldOfError(undefined)).toEqual({ index: null, field: null });
  });
});

describe('formatting', () => {
  it('shows ohms as kΩ and the deviation with its sign', () => {
    expect(formatOhm(88120, 'de-DE')).toBe('88,12 kΩ');
    expect(formatOhm(null, 'de-DE')).toBe('–');
    expect(formatDelta(5.1, 'de-DE')).toBe('+5,1 %');
    expect(formatDelta(-0.8, 'en-US')).toBe('-0.8 %');
    expect(formatDelta(null, 'de-DE')).toBe('–');
  });
});

describe('sensorStatus', () => {
  it('is the newest measurement status, "ungemessen" without one', () => {
    const row = { letzte_messung: null } as FactorySensorRow;
    expect(sensorStatus(row)).toBe('ungemessen');
    expect(
      sensorStatus({
        letzte_messung: { status: 'pruefen' },
      } as FactorySensorRow),
    ).toBe('pruefen');
  });
});
