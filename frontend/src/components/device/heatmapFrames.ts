/**
 * Frame-export helpers for the sensor heatmap: capture PNG frames from the
 * plot, draw a timestamp label onto a canvas, and package the frames together
 * with ffmpeg scripts into a ZIP. Extracted from SensorHeatmap2D so the
 * component stays focused on rendering.
 */

import { buildStoredZip } from './frameZip';

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
) =>
  new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error('Could not decode the captured frame.'));
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
) => {
  const text = `${formatTimestamp(timestamp)}  \u00B7  frame ${frameNumber}/${totalFrames}`;
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

/**
 * Package captured PNG frames plus ffmpeg scripts (Windows .bat + Linux/macOS
 * .sh) and a README into a store-only ZIP. The scripts assemble the frames
 * into an MP4 with ffmpeg.
 */
export const buildFrameArchive = (
  frameFiles: Array<{ name: string; data: Uint8Array }>,
  ffmpegCommand: string,
): Blob => {
  const encoder = new TextEncoder();

  const makeVideoBat = [
    '@echo off',
    'REM Assemble the sensor heatmap frames into an MP4 (Windows).',
    'REM Requires ffmpeg (https://ffmpeg.org/) on PATH.',
    ffmpegCommand.replace(/%/g, '%%'),
    'if errorlevel 1 goto :error',
    'echo.',
    'echo Done: sensor-heatmap.mp4',
    'pause',
    'exit /b 0',
    ':error',
    'echo ffmpeg failed - is it installed and on PATH?',
    'pause',
    'exit /b 1',
    '',
  ].join('\r\n');

  const makeVideoSh = [
    '#!/usr/bin/env bash',
    '# Assemble the sensor heatmap frames into an MP4 (Linux/macOS).',
    '# Requires ffmpeg (https://ffmpeg.org/) on PATH.',
    'set -e',
    ffmpegCommand,
    'echo "Done: sensor-heatmap.mp4"',
    '',
  ].join('\n');

  const readme = [
    'Sensor heatmap video frames',
    '==========================',
    '',
    'Each frame is a lossless PNG of the heatmap at one timestamp, labeled',
    'with the timestamp date/time and a frame counter.',
    '',
    'To assemble an MP4 with ffmpeg:',
    '',
    `    ${ffmpegCommand}`,
    '',
    'Or run make_video.bat (Windows) / make_video.sh (Linux/macOS) from',
    'this folder after installing ffmpeg (https://ffmpeg.org/).',
    '',
    'Tip: raise -framerate for a smoother video, e.g. -framerate 12.',
    '',
  ].join('\n');

  return buildStoredZip([
    ...frameFiles,
    { name: 'make_video.bat', data: encoder.encode(makeVideoBat) },
    { name: 'make_video.sh', data: encoder.encode(makeVideoSh) },
    { name: 'README.txt', data: encoder.encode(readme) },
  ]);
};
