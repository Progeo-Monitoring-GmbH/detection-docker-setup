/**
 * The alarm threshold area of the compare chart's first plot as ONE shape:
 * at each sensor x it spans ±(the sensor's own threshold, else the
 * location's). Drawn as one SVG path (data coordinates), so a sensor with an
 * own threshold looks exactly like the rest of the area - no second layer
 * whose colour adds up, no gaps between neighbouring sensors.
 *
 * Sensor x runs 1..lastSensor (pair index + 1); each sensor covers x ± 0.5,
 * cut at 1 and lastSensor so the shape doesn't widen the x-axis.
 */
export const thresholdAreaPath = (
  threshold: number | null | undefined,
  ownThresholds: ReadonlyMap<number, number> | null | undefined,
  lastSensor: number,
): string | null => {
  const base = threshold != null && threshold > 0 ? threshold : 0;
  const last = Math.max(1, Math.floor(lastSensor));
  // Single sensor: no neighbours to cut at - its own ±0.5.
  const [low, high] = last > 1 ? [1, last] : [0.5, 1.5];

  // Consecutive x-intervals of equal height: [x0, x1, height].
  const steps: [number, number, number][] = [];
  for (let x = 1; x <= last; x += 1) {
    const own = ownThresholds?.get(x - 1);
    const height = own != null && own > 0 ? own : base;
    const x0 = Math.max(x - 0.5, low);
    const x1 = Math.min(x + 0.5, high);
    const previous = steps[steps.length - 1];
    if (previous && previous[2] === height && previous[1] === x0) {
      previous[1] = x1;
    } else {
      steps.push([x0, x1, height]);
    }
  }

  // Runs of touching steps with a height form one polygon: along the top
  // from left to right, back along the mirrored bottom.
  const polygons: string[] = [];
  let run: [number, number, number][] = [];
  const close = () => {
    if (!run.length) {
      return;
    }
    const top = run.flatMap(([x0, x1, h]) => [`${x0},${h}`, `${x1},${h}`]);
    const bottom = [...run].reverse().flatMap(([x0, x1, h]) => [`${x1},${-h}`, `${x0},${-h}`]);
    polygons.push(`M${[...top, ...bottom].join('L')}Z`);
    run = [];
  };
  steps.forEach((step) => {
    if (step[2] > 0) {
      run.push(step);
    } else {
      close();
    }
  });
  close();
  return polygons.length ? polygons.join(' ') : null;
};
