/**
 * The Schwellwerte "mixer" (Einstellungen): the object's alarm threshold plus
 * per-sensor overrides, edited as drafts and saved as the minimal set of
 * changes. A sensor without an override inherits the object's threshold.
 */

/** A sensor of GET /v1/location/<id>/measurepoints/?days=N. */
export type MixerSensor = {
  sensor_order: number;
  id: number | null;
  name: string | null;
  /** The saved override; null = inherits the object's threshold. */
  threshold: number | null;
  /** Highest alarm value |WP - EP| of the period; null without one. */
  max: number | null;
};

/** Unsaved edits. `object` undefined = unchanged (null = no object threshold);
 * `sensors[order]` null = remove that sensor's override. */
export type ThresholdDrafts = {
  object?: number | null;
  sensors: Record<number, number | null>;
};

export const NO_DRAFTS: ThresholdDrafts = { sensors: {} };

export type ThresholdChange =
  | { key: 'object'; kind: 'object'; from: number | null; to: number | null }
  | { key: string; kind: 'sensor'; sensorOrder: number; from: number | null; to: number | null };

export const objectThresholdOf = (saved: number | null, drafts: ThresholdDrafts) =>
  drafts.object !== undefined ? drafts.object : saved;

/** The sensor's override with the drafts applied (null = inherits). */
export const overrideOf = (sensor: MixerSensor, drafts: ThresholdDrafts) =>
  sensor.sensor_order in drafts.sensors ? drafts.sensors[sensor.sensor_order] : sensor.threshold;

/** The threshold the sensor is checked against: its override, else the object's. */
export const effectiveThresholdOf = (sensor: MixerSensor, savedObject: number | null, drafts: ThresholdDrafts) =>
  overrideOf(sensor, drafts) ?? objectThresholdOf(savedObject, drafts);

/** Its period's maximum lies above its effective threshold. */
export const isOver = (sensor: MixerSensor, savedObject: number | null, drafts: ThresholdDrafts) => {
  const threshold = effectiveThresholdOf(sensor, savedObject, drafts);
  return sensor.max != null && threshold != null && sensor.max > threshold;
};

/** Above the object's threshold but not its own (higher) one: its own
 * threshold protects it from the alarm - drawn striped. */
export const isProtected = (sensor: MixerSensor, savedObject: number | null, drafts: ThresholdDrafts) => {
  const object = objectThresholdOf(savedObject, drafts);
  return (
    overrideOf(sensor, drafts) != null &&
    sensor.max != null &&
    object != null &&
    sensor.max > object &&
    !isOver(sensor, savedObject, drafts)
  );
};

/** "Quiet": its period's maximum stays below `share` of its threshold (or it
 * has none) - the sensors the plot can hide to make room. */
export const QUIET_SHARE = 0.05;
export const isQuiet = (sensor: MixerSensor, savedObject: number | null, drafts: ThresholdDrafts) => {
  const threshold = effectiveThresholdOf(sensor, savedObject, drafts);
  return sensor.max == null || (threshold != null && threshold > 0 && sensor.max < threshold * QUIET_SHARE);
};

/** Round grid values up to `max` - about four lines, 1/2/2.5/5 x 10^n apart. */
export const gridValuesOf = (max: number) => {
  if (!(max > 0)) {
    return [0];
  }
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
  const values: number[] = [];
  for (let value = 0; value <= max + step * 1e-9; value += step) {
    values.push(Number(value.toFixed(6)));
  }
  return values;
};

/**
 * Only what really changes: the object threshold if it differs from the
 * saved one, and each sensor whose override differs from its saved one. A
 * sensor without an override that is set to exactly the object threshold
 * stays without one - that stores nothing new.
 */
export const thresholdChanges = (
  sensors: MixerSensor[],
  savedObject: number | null,
  drafts: ThresholdDrafts,
): ThresholdChange[] => {
  const changes: ThresholdChange[] = [];
  const object = objectThresholdOf(savedObject, drafts);
  if (drafts.object !== undefined && drafts.object !== savedObject) {
    changes.push({ key: 'object', kind: 'object', from: savedObject, to: drafts.object });
  }
  sensors.forEach((sensor) => {
    if (!(sensor.sensor_order in drafts.sensors)) {
      return;
    }
    let to = drafts.sensors[sensor.sensor_order];
    if (sensor.threshold == null && to != null && to === object) {
      to = null;
    }
    if (to !== sensor.threshold) {
      changes.push({
        key: `sensor-${sensor.sensor_order}`,
        kind: 'sensor',
        sensorOrder: sensor.sensor_order,
        from: sensor.threshold,
        to,
      });
    }
  });
  return changes;
};

/** The drafts with `orders` set to `value` (null removes their overrides). */
export const withOverrides = (drafts: ThresholdDrafts, orders: Iterable<number>, value: number | null) => {
  const sensors = { ...drafts.sensors };
  for (const order of orders) {
    sensors[order] = value;
  }
  return { ...drafts, sensors };
};

/** The drafts without the edit behind `change` (its undo). */
export const withoutChange = (drafts: ThresholdDrafts, change: ThresholdChange): ThresholdDrafts => {
  if (change.kind === 'object') {
    const { object: _object, ...rest } = drafts;
    return rest;
  }
  const { [change.sensorOrder]: _undone, ...sensors } = drafts.sensors;
  return { ...drafts, sensors };
};

/** The request bodies: PATCH of the object (if it changed), POST of the points. */
export const savePayloadOf = (changes: ThresholdChange[]) => {
  const object = changes.find((change) => change.kind === 'object');
  return {
    object: object ? { alarm_threshold: object.to } : null,
    points: changes.flatMap((change) =>
      change.kind === 'sensor' ? [{ sensor_order: change.sensorOrder, threshold: change.to }] : [],
    ),
  };
};

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/** Dragging snaps to this: about 1/200 of the scale, a round number. */
export const snapStepOf = (scaleMax: number) =>
  STEPS.find((step) => step >= scaleMax / 200) ?? STEPS[STEPS.length - 1];

export const snapped = (value: number, step: number) => {
  const rounded = Math.round(value / step) * step;
  // No float dust (0.30000000000000004) in what gets saved.
  return Math.max(0, Number(rounded.toFixed(step < 1 ? 1 : 0)));
};

/** Every n-th sensor gets an x-axis label - about 40 px apart. */
export const labelEveryOf = (columnWidth: number) =>
  [1, 2, 5, 10, 20, 50, 100].find((every) => every * columnWidth >= 40) ?? 100;

/** Sensors from `anchor` to `order` (Shift+click), in plot order. */
export const rangeBetween = (orders: number[], anchor: number, order: number) => {
  const from = orders.indexOf(anchor);
  const to = orders.indexOf(order);
  if (from < 0 || to < 0) {
    return [order];
  }
  return orders.slice(Math.min(from, to), Math.max(from, to) + 1);
};
