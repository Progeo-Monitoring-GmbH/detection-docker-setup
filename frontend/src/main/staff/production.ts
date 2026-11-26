/**
 * The staff page of the production record dm (ProductionView): types of
 * GET /v1/werk/produktion/ and POST /v1/werk/produktion/qs/
 * (helper/production_overview.py) and the pure helpers.
 */

export const OVERVIEW_URL = '/v1/werk/produktion/';
export const QS_URL = `${OVERVIEW_URL}qs/`;
export const DAYS = 14;

export const overviewUrl = (order: string | null) =>
  `${OVERVIEW_URL}?tage=${DAYS}${order ? `&auftrag=${encodeURIComponent(order)}` : ''}`;

/** The look of a value - the manuSensor app's rules (SheetRules.kt). */
export type Flag = 'none' | 'ok' | 'warn' | 'bad';
export type Measure = 'r_platine' | 'r_aufgespult' | 'r_kurzschluss';
export const MEASURES: Measure[] = ['r_platine', 'r_aufgespult', 'r_kurzschluss'];

export type Reading = { ohm: number | null; status: string | null; flag: Flag };

/** "QS-Prüfung" in "dm Sensoren". */
export type QsStatus = 'OK' | 'Nacharbeit' | 'Prüfen';
export type Qs = {
  status: QsStatus;
  manuell: boolean;
  von: string | null;
  am: string | null;
};

/** A sensor with a bad value ("fehler") or a warning. */
export type FlaggedEntry = {
  sensor_record_id: string;
  sensor: string;
  auftrag_id: string;
  order_record_id: string;
  projekt: number | null;
  werte: Record<Measure, Reading>;
  stufe: 'fehler' | 'warnung';
  erfasst_am: string;
  kuerzel: string | null;
  /** null: a draft - its sheet isn't released yet. */
  blatt: number | null;
  /** Released on purpose with this value (the app asked). */
  bestaetigt: boolean;
  nach_freigabe_geaendert: boolean;
  /** null: not released yet, no QS check. */
  qs: Qs | null;
};

export type ProductionDay = {
  datum: string;
  sensoren: number;
  messband_m: number;
  vorlauf_m: number;
};

export type ProductionOrder = {
  id: string;
  auftrag_id: string;
  nr: number | null;
  projekt: string | null;
  objekt: string | null;
  erfasst: number;
  gesamt: number | null;
  blaetter_freigegeben: number;
  blaetter: number | null;
  fehler: number;
  warnungen: number;
  qs_offen: number;
  zuletzt: string | null;
};

export type ProductionRoll = {
  nummer: string;
  typ: 'messband' | 'vorlauf';
  kabeltyp: string | null;
  nennlaenge_m: number | null;
  start_metrierung_m: number | null;
  metrierung_m: number | null;
  rest_m: number | null;
  leer: boolean;
  code: string | null;
  code_format: string | null;
  fotos: string[];
  zuletzt: {
    geraet_id: string | null;
    benutzer: string | null;
    auftrag_id: string | null;
    am: string | null;
  } | null;
  /** Sensors produced with it. */
  sensoren: number;
};

export type ProductionFigures = {
  sensoren_heute: number;
  messband_heute_m: number;
  vorlauf_heute_m: number;
  erfasst: number;
  gesamt: number;
  auftraege: number;
  fehler: number;
  warnungen: number;
  qs_offen: number;
};

export type ProductionOverview = {
  kennzahlen: ProductionFigures;
  tage: ProductionDay[];
  auftraege: ProductionOrder[];
  auffaellig: FlaggedEntry[];
  rollen: ProductionRoll[];
};

const NONE = '–';

/** 99870 -> "99 870 Ω", offen -> the given word. */
export const formatReading = (reading: Reading, locale: string, open: string) => {
  if (reading.status === 'offen') {
    return open;
  }
  return reading.ohm == null ? NONE : `${reading.ohm.toLocaleString(locale)} Ω`;
};

export const formatMeters = (meters: number | null | undefined, locale: string) =>
  meters == null
    ? NONE
    : `${meters.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m`;

/** "97 · 7099 BDK1 und BDK2 De Soto" - the ID when Airtable couldn't say. */
export const orderLabel = (order: ProductionOrder) =>
  order.nr == null && !order.projekt
    ? order.auftrag_id
    : [order.nr, [order.projekt, order.objekt].filter(Boolean).join(' ')]
        .filter((part) => part != null && part !== '')
        .join(' · ');

/** "7099 · dm 001132": the orders of the flagged list in their short form. */
export const orderNumber = (auftragId: string) => {
  const match = /_(\d+)_(\d+)$/.exec(auftragId);
  return match ? `${match[2]} · ${match[1]}` : auftragId;
};

/** A share 0..1 for a progress bar (0 without a total). */
export const share = (done: number, total: number | null | undefined) =>
  total ? Math.min(1, Math.max(0, done / total)) : 0;
