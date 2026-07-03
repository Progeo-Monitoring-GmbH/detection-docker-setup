import React, { useEffect, useMemo, useRef } from 'react';
import { Card } from 'react-bootstrap';
import { plotTheme } from '../../styles/plotTheme';

export type HeatmapPoint = {
  x: number;
  y: number;
  radius?: number;
  intensity?: number;
};

type MeasurementHeatmapProps = {
  points: HeatmapPoint[];
  width?: number;
  height?: number;
  title?: string;
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const toRgb = (hex: string) => {
  const clean = hex.replace('#', '');
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
};

const lerpColor = (
  left: { r: number; g: number; b: number },
  right: { r: number; g: number; b: number },
  t: number,
) => ({
  r: Math.round(left.r + (right.r - left.r) * t),
  g: Math.round(left.g + (right.g - left.g) * t),
  b: Math.round(left.b + (right.b - left.b) * t),
});

const heatStops = [
  { at: 0.0, color: toRgb(plotTheme.warmGray1) },
  { at: 0.2, color: toRgb(plotTheme.contrastCyan) },
  { at: 0.45, color: toRgb(plotTheme.contrastGreen) },
  { at: 0.7, color: toRgb(plotTheme.contrastYellow) },
  { at: 1.0, color: toRgb(plotTheme.brandOrange) },
];

const palette = (tRaw: number) => {
  const t = clamp(tRaw, 0, 1);
  for (let i = 0; i < heatStops.length - 1; i += 1) {
    const left = heatStops[i];
    const right = heatStops[i + 1];
    if (t >= left.at && t <= right.at) {
      const relative = (t - left.at) / (right.at - left.at || 1);
      return lerpColor(left.color, right.color, relative);
    }
  }
  return heatStops[heatStops.length - 1].color;
};

const MeasurementHeatmap = ({
  points,
  width = 760,
  height = 340,
  title = 'Heatmap',
}: MeasurementHeatmapProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const safePoints = useMemo(
    () =>
      (points || []).filter(
        (point) =>
          Number.isFinite(point?.x) &&
          Number.isFinite(point?.y) &&
          Number.isFinite(point?.radius ?? point?.intensity ?? 0),
      ),
    [points],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);

    const alphaCanvas = document.createElement('canvas');
    alphaCanvas.width = width;
    alphaCanvas.height = height;
    const alphaCtx = alphaCanvas.getContext('2d');
    if (!alphaCtx) {
      return;
    }

    alphaCtx.clearRect(0, 0, width, height);
    alphaCtx.globalCompositeOperation = 'lighter';

    safePoints.forEach((point) => {
      const radius = clamp(
        Number(point.radius ?? point.intensity ?? 0),
        1,
        400,
      );
      const weight = clamp(Number(point.intensity ?? radius / 80), 0.05, 1.0);

      const gradient = alphaCtx.createRadialGradient(
        point.x,
        point.y,
        0,
        point.x,
        point.y,
        radius,
      );
      gradient.addColorStop(0, `rgba(255, 255, 255, ${weight})`);
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

      alphaCtx.fillStyle = gradient;
      alphaCtx.beginPath();
      alphaCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      alphaCtx.fill();
    });

    const image = alphaCtx.getImageData(0, 0, width, height);
    const data = image.data;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      if (alpha <= 0) {
        continue;
      }

      const { r, g, b } = palette(alpha);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(clamp(alpha * 255 * 1.2, 0, 255));
    }

    ctx.fillStyle = plotTheme.brandBlue;
    ctx.fillRect(0, 0, width, height);
    ctx.putImageData(image, 0, 0);

    // Soft bloom pass for smoother merges.
    ctx.globalAlpha = 0.45;
    ctx.filter = 'blur(8px)';
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;

    // Draw points lightly on top for orientation.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    safePoints.forEach((point) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [safePoints, width, height]);

  return (
    <Card className="border-0 shadow-sm">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-2">
          <h5 className="mb-0">{title}</h5>
          <small className="text-muted">
            {safePoints.length} points | smooth additive merge
          </small>
        </div>
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          style={{ width: '100%', height: 'auto', borderRadius: 10 }}
        />
      </Card.Body>
    </Card>
  );
};

export default MeasurementHeatmap;
