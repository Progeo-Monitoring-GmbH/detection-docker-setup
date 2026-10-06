/**
 * Positions on a Lageplan in meters - the frontend twin of
 * progeo/helper/plan_meters.py (keep both in sync).
 *
 * A measure point's normalized (nx, ny) is placed on the plan by the plan's
 * alignment (offset/scale/flip from the alignment wizard) and measured from
 * the plan's reference point with its meters_per_pixel ratio:
 *
 *   x_m = (px - reference_x) * meters_per_pixel   (x to the right)
 *   y_m = (reference_y - py) * meters_per_pixel   (y up, like a site plan)
 *
 * (px, py) are pixels of the original image (x right, y down).
 */
import { alignmentBaseScale } from '../ui/ImageCanvasStage';

export type PlanScale = {
  offset_x?: number | null;
  offset_y?: number | null;
  scale_x?: number | null;
  scale_y?: number | null;
  flip_y?: boolean | null;
  reference_x?: number | null;
  reference_y?: number | null;
  meters_per_pixel?: number | null;
};

export type ImageSize = { width: number; height: number };

export const isCalibrated = (plan: PlanScale | null | undefined) =>
  plan?.reference_x != null &&
  plan?.reference_y != null &&
  Boolean(plan?.meters_per_pixel);

/** Image pixel of a normalized measure point under the plan's alignment. */
export const planPixel = (
  nx: number,
  ny: number,
  plan: PlanScale,
  { width, height }: ImageSize,
): [number, number] => {
  const baseScale = alignmentBaseScale(width, height);
  const v = plan.flip_y ? 1 - ny : ny;
  const fractionX =
    (plan.offset_x ?? 0) / (width * baseScale) + nx * (plan.scale_x || 1);
  const fractionY =
    (plan.offset_y ?? 0) / (height * baseScale) + v * (plan.scale_y || 1);
  return [fractionX * width, fractionY * height];
};

export const pixelToMeters = (
  px: number,
  py: number,
  plan: PlanScale | null | undefined,
): [number, number] | null => {
  if (!plan || !isCalibrated(plan)) {
    return null;
  }
  const ratio = plan.meters_per_pixel as number;
  return [
    (px - (plan.reference_x as number)) * ratio,
    ((plan.reference_y as number) - py) * ratio,
  ];
};

/** Meter position of a measure point, null when not calibrated. */
export const pointMeters = (
  nx: number,
  ny: number,
  plan: PlanScale | null | undefined,
  size: ImageSize | null | undefined,
): [number, number] | null => {
  if (!plan || !size || !isCalibrated(plan)) {
    return null;
  }
  return pixelToMeters(...planPixel(nx, ny, plan, size), plan);
};

/** "x 12.34 m, y -3.21 m" */
export const formatMeters = ([x, y]: [number, number]) =>
  `x ${x.toFixed(2)} m, y ${y.toFixed(2)} m`;
