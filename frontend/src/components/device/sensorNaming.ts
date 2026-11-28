/**
 * How the measurement plots name a sensor (pair index from 0) when the
 * pairs are not one device's: the Analyse tab's "all devices" puts the
 * devices' pairs one after another (main/analyseDevices.ts). Without one the
 * plots count the pairs ("Sensor 5").
 */
export type SensorNaming = {
  /** The full name - tooltips, the second plot's legend and chips. */
  name: (sensor: number) => string;
  /** The short label under a column of the first plot. */
  tick: (sensor: number) => string;
  /** Where each group (device) starts - a divider with its label. */
  groups: { start: number; label: string }[];
};
