/**
 * The staff page of the dm sensors' factory values (FactorySensorsView):
 * types of GET /v1/werk/sensoren/ (helper/manusensor.py staff_overview) and
 * the pure helpers - CSV paste, server errors, formatting.
 */

export const SENSORS_URL = '/v1/werk/sensoren/';
export const historyUrl = (id: number) => `${SENSORS_URL}${id}/messungen/`;
/** The Django admin of a factory sensor - corrections are made there. */
export const adminUrl = (id: number) =>
  `/aadmin/progeo/progeofactorysensor/${id}/change/`;

export type MeasurementStatus = 'ok' | 'pruefen' | 'defekt' | 'unbekannt';
export type SensorStatus = MeasurementStatus | 'ungemessen';
export const SENSOR_STATUSES: SensorStatus[] = [
  'ok',
  'pruefen',
  'defekt',
  'unbekannt',
  'ungemessen',
];

/** A site measurement (measurement_row). */
export type SiteMeasurement = {
  id: number;
  projekt: string;
  sensor: string;
  zeit: string;
  r_ohm: number | null;
  r_status: 'ok' | 'offen' | 'kurzschluss';
  r_werk_ohm: number | null;
  delta_prozent: number | null;
  status: MeasurementStatus;
  tag_uid: string | null;
  tag_passt_nicht: boolean;
  identifizierung: string;
  geraet: string;
  benutzer: string | null;
};

export type FactorySensorRow = {
  id: number;
  projekt: string;
  sensor: string;
  band: string | null;
  tag_uid: string | null;
  r_werk_ohm: number;
  gemessen_am: string | null;
  messungen: number;
  letzte_messung: SiteMeasurement | null;
};

export type UnmatchedMeasurement = SiteMeasurement & {
  /** Factory values were created after the measurement. */
  werkswert_vorhanden: boolean;
};

export type SensorsOverview = {
  sensoren: FactorySensorRow[];
  ohne_werkswert: UnmatchedMeasurement[];
  kennzahlen: Record<SensorStatus | 'sensoren' | 'ohne_werkswert', number>;
  projekte: string[];
  toleranz_prozent: number;
};

/** One sensor as POST /v1/werk/sensoren/ takes it. */
export type FactorySensorInput = {
  projekt: string;
  sensor: string;
  band: string | null;
  tag_uid: string | null;
  r_werk_ohm: number | string;
  gemessen_am: string | null;
};

export const sensorStatus = (row: FactorySensorRow): SensorStatus =>
  row.letzte_messung?.status ?? 'ungemessen';

const COLUMNS = [
  'projekt',
  'sensor',
  'band',
  'tag_uid',
  'r_werk_ohm',
  'gemessen_am',
] as const;
type Column = (typeof COLUMNS)[number];

const PROJECT = /^\d{1,9}$/;
const SENSOR = /^\d{1,6}$/;
const OHM = /^\d+$/;

export type CsvError = { line: number; field: Column };

/**
 * Pasted rows of the import command's format (manage.py
 * import_factory_sensors): "projekt;sensor;band;tag_uid;r_werk_ohm;gemessen_am",
 * separated by ";" or tabs (a spreadsheet's copy). A header row sets the
 * column order, without one the order above. Lines with a project, sensor or
 * R_Werk that can't be sent come back as errors (1-based line); the server
 * checks the rest. `lines`: the line of each row.
 */
export const parseSensorCsv = (
  text: string,
): { rows: FactorySensorInput[]; lines: number[]; errors: CsvError[] } => {
  const lines = text.split(/\r?\n/);
  const split = (line: string) =>
    line.split(/[;\t]/).map((cell) => cell.trim());
  let order: readonly string[] = COLUMNS;
  const rows: FactorySensorInput[] = [];
  const rowLines: number[] = [];
  const errors: CsvError[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    const cells = split(line);
    if (index === 0 && cells.some((cell) => cell.toLowerCase() === 'projekt')) {
      order = cells.map((cell) => cell.toLowerCase());
      return;
    }
    const value = (column: Column) => {
      const position = order.indexOf(column);
      return position >= 0 ? (cells[position] ?? '') : '';
    };
    const ohm = value('r_werk_ohm');
    const row: FactorySensorInput = {
      projekt: value('projekt'),
      sensor: value('sensor'),
      band: value('band') || null,
      tag_uid: value('tag_uid') || null,
      r_werk_ohm: OHM.test(ohm) ? Number(ohm) : ohm,
      gemessen_am: value('gemessen_am') || null,
    };
    const line1 = index + 1;
    if (!PROJECT.test(row.projekt)) {
      errors.push({ line: line1, field: 'projekt' });
    } else if (!SENSOR.test(row.sensor)) {
      errors.push({ line: line1, field: 'sensor' });
    } else if (typeof row.r_werk_ohm !== 'number' || row.r_werk_ohm <= 0) {
      errors.push({ line: line1, field: 'r_werk_ohm' });
    }
    rows.push(row);
    rowLines.push(line1);
  });
  return { rows, lines: rowLines, errors };
};

/** "sensoren[3].r_werk_ohm" (a 422's "feld") -> row 3, field r_werk_ohm. */
export const fieldOfError = (
  feld: string | null | undefined,
): { index: number | null; field: string | null } => {
  const match = /^sensoren\[(\d+)\]\.(\w+)$/.exec(feld ?? '');
  return match
    ? { index: Number(match[1]), field: match[2] }
    : { index: null, field: null };
};

const NONE = '–';

export const formatOhm = (ohm: number | null | undefined, locale: string) =>
  ohm == null
    ? NONE
    : `${(ohm / 1000).toLocaleString(locale, { maximumFractionDigits: 2 })} kΩ`;

export const formatDelta = (
  delta: number | null | undefined,
  locale: string,
) => {
  if (delta == null) {
    return NONE;
  }
  const text = Math.abs(delta).toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${delta > 0 ? '+' : delta < 0 ? '-' : ''}${text} %`;
};
