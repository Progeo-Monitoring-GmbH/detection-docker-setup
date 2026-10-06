/**
 * Frame-export helpers for the sensor heatmap: capture PNG frames from the
 * plot and draw a timestamp label onto a canvas. The frames are rendered into
 * a video on the backend (see useHeatmapFrameExport). Extracted from
 * SensorHeatmap2D so the component stays focused on rendering.
 */

export const formatTimestamp = (timestamp: number | null | undefined) => {
  if (timestamp == null) {
    return 'n/a';
  }
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) {
    return String(timestamp);
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

export const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });

export const canvasToPngBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export const loadImageFromDataUrl = (
  image: HTMLImageElement,
  dataUrl: string,
  errorMessage = 'Could not decode the captured frame.',
) =>
  new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(errorMessage));
    image.src = dataUrl;
  });

/**
 * Draws the frame timestamp (date/time of that frame) plus a frame counter
 * into the bottom-right corner, on a translucent brand-blue pill.
 */
export const drawFrameLabel = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timestamp: number | null | undefined,
  frameNumber: number,
  totalFrames: number,
  frameWord = 'frame',
) => {
  const text = `${formatTimestamp(timestamp)}  \u00B7  ${frameWord} ${frameNumber}/${totalFrames}`;
  ctx.font = '600 20px system-ui, -apple-system, "Segoe UI", sans-serif';
  const textWidth = ctx.measureText(text).width;
  const padX = 14;
  const padY = 9;
  const boxWidth = textWidth + padX * 2;
  const boxHeight = 34;
  const x = width - boxWidth - 16;
  const y = height - boxHeight - 16;

  ctx.fillStyle = 'rgba(9, 75, 129, 0.85)';
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, boxWidth, boxHeight, 6);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, boxWidth, boxHeight);
  }

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + boxHeight / 2 + padY - 8);
};
