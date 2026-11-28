/**
 * Wizard step 2 (DeviceInputsStep.tsx): which sensor each input of the
 * location's devices measures - backend measure_points/device_inputs
 * (helper/device_inputs.py). Pure helpers: the sections of a device's
 * inputs, the runs of the overview graphic, editing a section, coverage and
 * the payload.
 */

/** Where an input's sensor comes from (helper/sensor_mapping.effective). */
export type InputSource = 'formula' | 'manual' | 'klemmliste' | 'merge' | 'mapped';

export type DeviceInputsRow = {
  device_id: number;
  label: string;
  hardware: string | null;
  first_sensor_order: number;
  sensor_count: number | null;
  measured_inputs: number;
  mapped: boolean;
  inputs: { position: number; sensor_order: number | null; source: InputSource }[];
};

export type DeviceInputsAnswer = {
  devices: DeviceInputsRow[];
  /** The location's measure point numbers. */
  sensors: number[];
  connected?: number;
};

/** One device being edited: inputs[0] is input 1, null = free. */
export type InputsDraft = {
  deviceId: number;
  label: string;
  inputs: (number | null)[];
  /** Inputs changed by hand - a later Klemmliste keeps them. */
  edited: number[];
};

/** The devices' colours, in order. */
export const DEVICE_COLORS = ['#2f6fde', '#13a38a', '#8b5cf6', '#d97706', '#db2777', '#0891b2'];
export const deviceColor = (index: number) => DEVICE_COLORS[index % DEVICE_COLORS.length];

export const asAnswer = (data: unknown): DeviceInputsAnswer | null => {
  if (!data || typeof data !== 'object' || !Array.isArray((data as DeviceInputsAnswer).devices)) {
    return null;
  }
  const answer = data as DeviceInputsAnswer;
  return { ...answer, sensors: Array.isArray(answer.sensors) ? answer.sensors : [] };
};

export const draftsFrom = (answer: DeviceInputsAnswer): InputsDraft[] =>
  answer.devices.map((device) => ({
    deviceId: device.device_id,
    label: device.label,
    inputs: device.inputs.map((input) => input.sensor_order),
    edited: [],
  }));

/** Sensors measured by more than one input (of any device). */
export const doubledSensors = (drafts: InputsDraft[]) => {
  const seen = new Set<number>();
  const doubled = new Set<number>();
  for (const draft of drafts) {
    for (const sensor of draft.inputs) {
      if (sensor == null) {
        continue;
      }
      if (seen.has(sensor)) {
        doubled.add(sensor);
      }
      seen.add(sensor);
    }
  }
  return doubled;
};

/** Whether the device counts linearly: input i measures first + i - 1, none free. */
export const isLinear = (inputs: (number | null)[]) =>
  inputs.length > 0 && inputs.every((sensor, index) => sensor != null && sensor === (inputs[0] as number) + index);

export type InputRun = { from: number; to: number; start: number; end: number };

/** Runs of inputs counting on by one (up or down) - the overview's bands. */
export const inputRuns = (inputs: (number | null)[]): InputRun[] => {
  const runs: InputRun[] = [];
  inputs.forEach((sensor, index) => {
    if (sensor == null) {
      return;
    }
    const position = index + 1;
    const run = runs[runs.length - 1];
    const step = run ? run.end - run.start : 0;
    const direction = step === 0 ? sensor - (run?.end ?? 0) : Math.sign(step);
    if (run && run.to === position - 1 && Math.abs(sensor - run.end) === 1 && sensor - run.end === direction) {
      run.to = position;
      run.end = sensor;
    } else {
      runs.push({ from: position, to: position, start: sensor, end: sensor });
    }
  });
  return runs;
};

/** A section of a device's inputs: a run counting on (up or down), a jump
 * (not one on from the sensor before it) or free inputs. */
export type Segment = {
  from: number;
  to: number;
  start: number | null;
  end: number | null;
  direction: 'up' | 'down';
  kind: 'count' | 'jump' | 'free';
};

/** The device's inputs as sections, input 1 to the last. */
export const segmentsOf = (inputs: (number | null)[]): Segment[] => {
  const segments: Segment[] = [];
  let next = 1;
  let lastEnd: number | null = null;
  const free = (from: number, to: number) =>
    segments.push({ from, to, start: null, end: null, direction: 'up', kind: 'free' });
  for (const run of inputRuns(inputs)) {
    if (run.from > next) {
      free(next, run.from - 1);
    }
    segments.push({
      ...run,
      direction: run.end < run.start ? 'down' : 'up',
      kind: lastEnd == null || Math.abs(run.start - lastEnd) === 1 ? 'count' : 'jump',
    });
    lastEnd = run.end;
    next = run.to + 1;
  }
  if (next <= inputs.length) {
    free(next, inputs.length);
  }
  return segments;
};

/** The inputs from..to (1-based) set to start, start+1, ... (or down), or
 * free (start null); inputs beyond the device's are added. */
export const withRun = (
  draft: InputsDraft,
  from: number,
  to: number,
  start: number | null,
  direction: 'up' | 'down' = 'up',
): InputsDraft => {
  const low = Math.max(1, Math.min(from, to));
  const high = Math.max(from, to);
  const inputs = [...draft.inputs];
  while (inputs.length < high) {
    inputs.push(null);
  }
  const edited = new Set(draft.edited);
  for (let position = low; position <= high; position += 1) {
    const offset = position - low;
    const sensor = start == null ? null : direction === 'up' ? start + offset : start - offset;
    inputs[position - 1] = sensor != null && sensor >= 1 ? sensor : null;
    edited.add(position);
  }
  return { ...draft, inputs, edited: [...edited].sort((a, b) => a - b) };
};

/** The device with `count` inputs: new ones free, the last ones dropped. */
export const withInputCount = (draft: InputsDraft, count: number): InputsDraft => {
  const size = Math.max(0, Math.floor(count));
  const inputs = draft.inputs.slice(0, size);
  while (inputs.length < size) {
    inputs.push(null);
  }
  return { ...draft, inputs, edited: draft.edited.filter((position) => position <= size) };
};

/** "1, 5-9, 12" of sorted numbers. */
export const numberRanges = (numbers: number[]) => {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) {
      end += 1;
    }
    parts.push(end === index ? String(sorted[index]) : `${sorted[index]}–${sorted[end]}`);
    index = end + 1;
  }
  return parts.join(', ');
};

/** The location's measure points no input measures, and the doubled sensors. */
export const coverage = (drafts: InputsDraft[], sensors: number[]) => {
  const measured = new Set(drafts.flatMap((draft) => draft.inputs.filter((sensor): sensor is number => sensor != null)));
  return {
    missing: sensors.filter((sensor) => !measured.has(sensor)),
    doubled: [...doubledSensors(drafts)].sort((a, b) => a - b),
    measured: measured.size,
  };
};

export const isDirty = (drafts: InputsDraft[], answer: DeviceInputsAnswer | null) =>
  answer !== null &&
  drafts.some((draft) => {
    const saved = answer.devices.find((device) => device.device_id === draft.deviceId);
    const before = saved?.inputs.map((input) => input.sensor_order) ?? [];
    return before.length !== draft.inputs.length || before.some((sensor, index) => sensor !== draft.inputs[index]);
  });

/** POST measure_points/device_inputs. */
export const savePayload = (locationId: number, drafts: InputsDraft[]) => ({
  location_id: locationId,
  devices: drafts.map((draft) => ({ device_id: draft.deviceId, inputs: draft.inputs, edited: draft.edited })),
});
