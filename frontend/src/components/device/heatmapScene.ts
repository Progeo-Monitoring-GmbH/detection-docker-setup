/**
 * Drawing of SensorHeatmap2D onto a 2D canvas - the same scene on screen and
 * in every frame of the video export: the plan and the heat field (zoomed
 * and moved), then at screen size the reference point with its guides, the
 * sensor markers and the colour scale.
 */
import { plotTheme } from '../../styles/plotTheme';
import { heatPixels, toScreen, type View } from './heatmapCanvas';
import type { ChartFrame, ChartLayout } from './heatmapChart';

/** Opacity of the heat field over the plan. */
const HEAT_OPACITY = 0.7;
const MARKER_RADIUS = 4.5;
/** Marker of a sensor reading above its threshold. */
const OVER_THRESHOLD_COLOR = '#dc2626';
const LABEL_FONT = '600 10px system-ui, sans-serif';
const HIGHLIGHTED_LABEL_FONT = '700 12px system-ui, sans-serif';

export type Scene = {
  layout: ChartLayout;
  frame: ChartFrame;
  image: HTMLImageElement | null;
  /** The heat field, one pixel per grid cell (heatFieldCanvas). */
  heatCanvas: HTMLCanvasElement | null;
  colorTable: Uint8ClampedArray;
  /** Text next to a sensor's marker (index into layout.sensors). */
  sensorText: (index: number) => string;
  /** Title of the colour scale, and the label of a tick (0..1 of the scale). */
  scaleTitle: string;
  tickLabel: (value: number) => string;
  /** The Lageplan's heat limitations (world coordinates): the heat field is
   * only drawn inside them. Empty: everywhere. */
  limits: Array<Array<[number, number]>>;
};

export type SceneOverlay = {
  /** Index of the hovered sensor. */
  hovered: number | null;
  /** Index of the sensor highlighted from outside (highlightedDevice). */
  highlighted: number | null;
  /** Cursor (screen pixels) the reference point's guides lead to. */
  cursor: [number, number] | null;
};

export type SceneSize = { width: number; height: number; dpr: number };

/** The heat field as an image (one pixel per grid cell), smoothed when drawn. */
export const heatFieldCanvas = (frame: ChartFrame, colorTable: Uint8ClampedArray) => {
  if (typeof document === 'undefined') {
    return null;
  }
  const size = frame.grid.length;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx || !size) {
    return null;
  }
  const image = ctx.createImageData(size, size);
  image.data.set(heatPixels(frame.grid, colorTable, frame.coverage ?? undefined));
  ctx.putImageData(image, 0, 0);
  return canvas;
};

/** World layer: plan + heat field, zoomed and moved. */
const drawWorld = (ctx: CanvasRenderingContext2D, scene: Scene, view: View, dpr: number) => {
  const { world, heatRect } = scene.layout;
  ctx.save();
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (scene.image) {
    ctx.drawImage(scene.image, 0, 0, world.width, world.height);
  }
  if (scene.heatCanvas) {
    if (scene.limits.length > 0) {
      // Heat limitations: the field only inside their union.
      ctx.beginPath();
      scene.limits.forEach((polygon) => {
        polygon.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
      });
      ctx.clip('nonzero');
    }
    ctx.globalAlpha = HEAT_OPACITY;
    ctx.drawImage(
      scene.heatCanvas,
      heatRect.left,
      heatRect.top,
      heatRect.right - heatRect.left,
      heatRect.bottom - heatRect.top,
    );
    ctx.globalAlpha = 1;
  }
  ctx.restore();
};

/** The dotted guides from the reference point to the cursor. */
const drawReferenceGuides = (
  ctx: CanvasRenderingContext2D,
  [rx, ry]: [number, number],
  [cx, cy]: [number, number],
) => {
  ctx.save();
  ctx.strokeStyle = plotTheme.green;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(rx, ry);
  ctx.lineTo(cx, ry);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  ctx.restore();
};

/** The reference point: a crossed circle. */
const drawReference = (ctx: CanvasRenderingContext2D, [rx, ry]: [number, number]) => {
  ctx.save();
  ctx.strokeStyle = plotTheme.green;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(rx, ry, 8, 0, Math.PI * 2);
  ctx.moveTo(rx - 8, ry);
  ctx.lineTo(rx + 8, ry);
  ctx.moveTo(rx, ry - 8);
  ctx.lineTo(rx, ry + 8);
  ctx.stroke();
  ctx.restore();
};

const drawMarker = (
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  emphasis: 'highlighted' | 'hovered' | null,
  over: boolean,
) => {
  if (emphasis === 'highlighted') {
    ctx.beginPath();
    ctx.arc(sx, sy, MARKER_RADIUS + 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fill();
    ctx.strokeStyle = plotTheme.brandOrange;
    ctx.lineWidth = 3;
    ctx.stroke();
  } else if (emphasis === 'hovered') {
    ctx.beginPath();
    ctx.arc(sx, sy, MARKER_RADIUS + 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(sx, sy, over ? MARKER_RADIUS + 1 : MARKER_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = over ? OVER_THRESHOLD_COLOR : plotTheme.brandBlue;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.stroke();
};

/** Readable on the plan and on the heat: white with a dark outline. */
const drawMarkerLabel = (
  ctx: CanvasRenderingContext2D,
  text: string,
  sx: number,
  sy: number,
  highlighted: boolean,
) => {
  const textY = sy - MARKER_RADIUS - (highlighted ? 7 : 2);
  ctx.font = highlighted ? HIGHLIGHTED_LABEL_FONT : LABEL_FONT;
  ctx.lineWidth = 3;
  ctx.strokeStyle = highlighted ? plotTheme.brandOrange : 'rgba(9, 75, 129, 0.85)';
  ctx.strokeText(text, sx, textY);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, sx, textY);
};

/** Sensor markers (screen size at any zoom) - the highlighted one last, on
 * top of its neighbours' labels; markers off screen are skipped. */
const drawSensors = (
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
  { width, height }: SceneSize,
  overlay: SceneOverlay,
) => {
  const { sensors } = scene.layout;
  const order = sensors.map((_, index) => index);
  if (overlay.highlighted != null) {
    order.push(...order.splice(overlay.highlighted, 1));
  }
  ctx.save();
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  order.forEach((index) => {
    const sensor = sensors[index];
    const [sx, sy] = toScreen(view, sensor.wx, sensor.wy);
    if (sx < -20 || sy < -20 || sx > width + 20 || sy > height + 20) {
      return;
    }
    const highlighted = overlay.highlighted === index;
    const hovered = overlay.hovered === index;
    const value = scene.frame.values[index];
    const over = sensor.threshold != null && value > sensor.threshold;
    drawMarker(ctx, sx, sy, highlighted ? 'highlighted' : hovered ? 'hovered' : null, over);
    drawMarkerLabel(ctx, scene.sensorText(index), sx, sy, highlighted);
  });
  ctx.restore();
};

/** Colour scale on the right (part of every frame of the video export). */
const drawColorBar = (ctx: CanvasRenderingContext2D, scene: Scene, { width, height }: SceneSize) => {
  const { colorTable } = scene;
  const barTop = 22;
  const barBottom = Math.max(barTop + 40, Math.min(height - 12, barTop + 220));
  const barX = width - 44;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.fillRect(barX - 6, barTop - 16, 50, barBottom - barTop + 26);
  const gradient = ctx.createLinearGradient(0, barBottom, 0, barTop);
  for (let index = 0; index <= 10; index += 1) {
    const color = Math.round((index / 10) * 255) * 3;
    gradient.addColorStop(
      index / 10,
      `rgb(${colorTable[color]}, ${colorTable[color + 1]}, ${colorTable[color + 2]})`,
    );
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(barX, barTop, 10, barBottom - barTop);
  ctx.fillStyle = plotTheme.brandBlue;
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(scene.scaleTitle, barX - 2, barTop - 5);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let tick = 0; tick <= 5; tick += 1) {
    const value = tick / 5;
    const y = barBottom - value * (barBottom - barTop);
    ctx.fillRect(barX + 10, y - 0.5, 3, 1);
    ctx.fillText(scene.tickLabel(value), barX + 15, y);
  }
  ctx.restore();
};

/** The canvas's 2D context, its backing store sized to width x height css
 * pixels at `dpr` (only resized when that changes - resizing clears it). */
export const sizedContext = (canvas: HTMLCanvasElement, width: number, height: number, dpr: number) => {
  const backingWidth = Math.round(width * dpr);
  const backingHeight = Math.round(height * dpr);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  return canvas.getContext('2d');
};

/** One video frame: the scene as shown on a screen of `screen` size, scaled
 * into a new width x height canvas on white. */
export const renderSceneFrame = (
  scene: Scene,
  view: View,
  screen: { width: number; height: number },
  width: number,
  height: number,
) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  const factor = Math.min(width / screen.width, height / screen.height);
  const frameView: View = {
    scale: view.scale * factor,
    tx: view.tx * factor + (width - screen.width * factor) / 2,
    ty: view.ty * factor + (height - screen.height * factor) / 2,
  };
  drawScene(
    ctx,
    scene,
    { width, height, dpr: 1 },
    frameView,
    { hovered: null, highlighted: null, cursor: null },
    '#ffffff',
  );
  return canvas;
};

/** Draws the whole scene for `view` onto ctx (css pixels x dpr), on
 * `background` (null: transparent). */
export const drawScene = (
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  size: SceneSize,
  view: View,
  overlay: SceneOverlay,
  background: string | null,
) => {
  const { width, height, dpr } = size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  drawWorld(ctx, scene, view, dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { reference } = scene.layout;
  const screenReference = reference ? toScreen(view, reference[0], reference[1]) : null;
  if (screenReference && overlay.cursor) {
    drawReferenceGuides(ctx, screenReference, overlay.cursor);
  }
  if (screenReference) {
    drawReference(ctx, screenReference);
  }
  drawSensors(ctx, scene, view, size, overlay);
  drawColorBar(ctx, scene, size);
};
