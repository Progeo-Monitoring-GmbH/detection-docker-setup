/**
 * Values of the controller's device_config.lua the frontend offers: the
 * config panel (DeviceConfigPanel) and the "set_params" command
 * (DeviceCommandsDialog) use the same lists.
 */

/** measurement.interval_sec choices. */
export const INTERVAL_OPTIONS = [
  { value: 30, label: '30s' },
  { value: 60, label: '1min' },
  { value: 300, label: '5min' },
  { value: 600, label: '10min' },
  { value: 900, label: '15min' },
  { value: 1800, label: '30min' },
  { value: 3600, label: '1h' },
  { value: 7200, label: '2h' },
  { value: 14400, label: '4h' },
  { value: 28800, label: '8h' },
  { value: 43200, label: '12h' },
  { value: 86400, label: '24h' },
];

/** ProgeoDevice.Resistance choices (pulldown_resistance in the file). */
export const RESISTANCE_OPTIONS = [
  { value: 136, labelKey: 'einstell_resistance_100k' },
  { value: 72, labelKey: 'einstell_resistance_10k' },
  { value: 40, labelKey: 'einstell_resistance_1k' },
  { value: 24, labelKey: 'einstell_resistance_100' },
  { value: 8, labelKey: 'einstell_resistance_off' },
];

/** control.poll_sec choices - 0: the controller never polls for commands. */
const POLL_OPTIONS = [
  { value: 60, label: '1min' },
  { value: 300, label: '5min' },
  { value: 900, label: '15min' },
  { value: 3600, label: '1h' },
  { value: 14400, label: '4h' },
  { value: 43200, label: '12h' },
  { value: 86400, label: '24h' },
  { value: 0, labelKey: 'device_commands_poll_never' },
];

export type ParamOption = { value: number; label?: string; labelKey?: string };

/**
 * The parameters "set_params" may change - exactly the ones the firmware
 * accepts (LUA_WLAN params.lua PARAMS), each with its valid values.
 */
export const SET_PARAMS: {
  key: string;
  labelKey: string;
  options: ParamOption[];
}[] = [
  {
    key: 'pulldown_resistance',
    labelKey: 'device_commands_param_pulldown_resistance',
    options: RESISTANCE_OPTIONS,
  },
  // The 30s..24h steps of the config panel.
  {
    key: 'interval_sec',
    labelKey: 'device_commands_param_interval_sec',
    options: INTERVAL_OPTIONS,
  },
  {
    key: 'poll_sec',
    labelKey: 'device_commands_param_poll_sec',
    options: POLL_OPTIONS,
  },
];

/**
 * The options of a set_params parameter. The M5 firmware has no 8 pulldown
 * (the input stays on) and always polls (no poll_sec 0).
 */
export const paramOptionsFor = (key: string, isM5: boolean): ParamOption[] => {
  const options = (SET_PARAMS.find((spec) => spec.key === key) ?? SET_PARAMS[0]).options;
  if (!isM5) {
    return options;
  }
  if (key === 'pulldown_resistance') {
    return options.filter((option) => option.value !== 8);
  }
  if (key === 'poll_sec') {
    return options.filter((option) => option.value !== 0);
  }
  return options;
};
