/**
 * Colours of the sensors followed in the measurements' second plot.
 *
 * Four hues, validated with the dataviz palette validator against the plot
 * surface (#eeebeb) on ALL pairs - lines overlap, so any two can meet:
 * colour-vision-deficiency ΔE >= 13.0 (deutan/protan), normal vision ΔE
 * >= 16.3, every hue >= 3:1 contrast. Orange and red are left out: the
 * plot's time marker is orange, alarm periods are red.
 *
 * No more hues than these four - more would put indistinguishable pairs on
 * screen. A 5th sensor and beyond repeat them with another line style
 * (dash, dot, dash-dot): 16 distinct lines.
 */
export const SENSOR_HUES = ['#2a78d6', '#d55181', '#008300', '#4a3aa7'] as const;
const SENSOR_DASHES = ['solid', 'dash', 'dot', 'dashdot'] as const;

export type SensorStyle = { color: string; dash: (typeof SENSOR_DASHES)[number] };

/** The style of a colour slot: hue first, then line style. */
export const sensorStyle = (slot: number): SensorStyle => ({
  color: SENSOR_HUES[slot % SENSOR_HUES.length],
  dash: SENSOR_DASHES[Math.floor(slot / SENSOR_HUES.length) % SENSOR_DASHES.length],
});

/**
 * The colour slots of the `selected` sensors: a sensor keeps its slot as
 * long as it stays selected (the colour follows the sensor, others coming
 * and going don't repaint it); a new one takes the lowest free slot.
 */
export const assignSlots = (previous: ReadonlyMap<number, number>, selected: number[]): Map<number, number> => {
  const slots = new Map<number, number>();
  selected.forEach((sensor) => {
    const kept = previous.get(sensor);
    if (kept != null) {
      slots.set(sensor, kept);
    }
  });
  const used = new Set(slots.values());
  let free = 0;
  selected.forEach((sensor) => {
    if (slots.has(sensor)) {
      return;
    }
    while (used.has(free)) {
      free += 1;
    }
    slots.set(sensor, free);
    used.add(free);
  });
  return slots;
};

/** SVG stroke-dasharray of a line style (legend swatches). */
export const dashArray = (dash: SensorStyle['dash']) =>
  ({ solid: undefined, dash: '6 3', dot: '1.5 3', dashdot: '6 3 1.5 3' })[dash];
