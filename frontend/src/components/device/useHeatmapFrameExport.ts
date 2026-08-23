import { useCallback, useRef, useState } from 'react';
import Plotly from 'plotly.js/dist/plotly';

import {
  buildFrameArchive,
  canvasToPngBlob,
  downloadBlob,
  drawFrameLabel,
  loadImageFromDataUrl,
  sleep,
} from './heatmapFrames';

export type AggregationMode = 'slice' | 'avg' | 'max';

const MAX_FRAMES = 120;
const FRAME_SLEEP_MS = 25;

type UseHeatmapFrameExportOptions = {
  /** The plot div that react-plotly.js mounts; used for Plotly.toImage. */
  plotRef: React.RefObject<HTMLDivElement | null>;
  /** Whether a chart is currently rendered (false -> export is disabled). */
  chartReady: boolean;
  timestamps: number[];
  mode: AggregationMode;
  timestampIndex: number;
  setTimestampIndex: (index: number) => void;
  setMode: (mode: AggregationMode) => void;
};

type HeatmapFrameExport = {
  videoExporting: boolean;
  videoProgress: number;
  videoError: string | null;
  /** Call after the Plot's onAfterPlot fires so frame redraws can be awaited. */
  handleAfterPlot: () => void;
  exportFrames: () => Promise<void>;
};

/**
 * Captures the heatmap animation over all timestamps as PNG frames and
 * downloads them as a ZIP together with ffmpeg scripts that assemble the
 * frames into an MP4. Frames are captured from the plot itself via
 * Plotly.toImage, drawn onto a canvas with a white background and the frame's
 * timestamp label, and stored as lossless PNGs.
 */
export const useHeatmapFrameExport = ({
  plotRef,
  chartReady,
  timestamps,
  mode,
  timestampIndex,
  setTimestampIndex,
  setMode,
}: UseHeatmapFrameExportOptions): HeatmapFrameExport => {
  const [videoExporting, setVideoExporting] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoError, setVideoError] = useState<string | null>(null);

  const afterPlotResolvers = useRef<Array<() => void>>([]);

  const waitForPlotRedraw = useCallback(
    (timeoutMs = 400) =>
      Promise.race([
        new Promise<void>((resolve) => {
          afterPlotResolvers.current.push(resolve);
        }),
        sleep(timeoutMs),
      ]),
    [],
  );

  const handleAfterPlot = useCallback(() => {
    const resolve = afterPlotResolvers.current.shift();
    resolve?.();
  }, []);

  const exportFrames = useCallback(async () => {
    const gd = plotRef.current;
    if (!gd || !chartReady || timestamps.length < 2 || videoExporting) {
      return;
    }

    setVideoExporting(true);
    setVideoProgress(0);
    setVideoError(null);

    const initialMode = mode;
    const initialIndex = timestampIndex;
    const frameStep = Math.max(1, Math.ceil(timestamps.length / MAX_FRAMES));
    const frameIndices: number[] = [];
    for (let index = 0; index < timestamps.length; index += frameStep) {
      frameIndices.push(index);
    }
    if (frameIndices[frameIndices.length - 1] !== timestamps.length - 1) {
      frameIndices.push(timestamps.length - 1);
    }

    const width = Math.min(Math.max(gd.clientWidth || 960, 320), 1280);
    const height = Math.min(Math.max(gd.clientHeight || 540, 240), 720);

    try {
      // The animation walks the timestamp slider, so force slice mode for the
      // duration of the export and restore the previous mode afterwards.
      if (mode !== 'slice') {
        setMode('slice');
        await waitForPlotRedraw();
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas 2D context unavailable.');
      }

      const frameBlobs: Blob[] = [];
      const frameImage = new Image();
      let previousIndex = initialIndex;

      for (let frame = 0; frame < frameIndices.length; frame += 1) {
        const frameIndex = frameIndices[frame];
        if (frameIndex !== previousIndex) {
          setTimestampIndex(frameIndex);
          await waitForPlotRedraw();
          previousIndex = frameIndex;
        }

        const dataUrl = await Plotly.toImage(gd, {
          format: 'png',
          width,
          height,
          scale: 1,
        });
        await loadImageFromDataUrl(frameImage, dataUrl);

        // The plot paper is transparent, so paint a background first to keep
        // the frames from rendering black on dark video players.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(frameImage, 0, 0, width, height);
        drawFrameLabel(
          ctx,
          width,
          height,
          timestamps[frameIndex],
          frame + 1,
          frameIndices.length,
        );

        const blob = await canvasToPngBlob(canvas);
        if (blob) {
          frameBlobs.push(blob);
        }

        // Let the browser breathe between frames so the progress UI updates.
        await sleep(FRAME_SLEEP_MS);
        setVideoProgress((frame + 1) / frameIndices.length);
      }

      if (!frameBlobs.length) {
        throw new Error('No frames could be captured.');
      }

      const frameFiles = await Promise.all(
        frameBlobs.map(async (blob, index) => ({
          name: `frames/frame_${String(index + 1).padStart(4, '0')}.png`,
          data: new Uint8Array(await blob.arrayBuffer()),
        })),
      );

      const ffmpegCommand =
        'ffmpeg -y -framerate 8 -i frames/frame_%04d.png -c:v libx264 ' +
        '-preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart ' +
        'sensor-heatmap.mp4';

      const zipBlob = buildFrameArchive(frameFiles, ffmpegCommand);
      downloadBlob(
        zipBlob,
        `sensor-heatmap-frames-${new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, '-')}.zip`,
      );
      setVideoProgress(1);
    } catch (error) {
      setVideoError((error as Error).message || 'Frame export failed.');
    } finally {
      setTimestampIndex(initialIndex);
      setMode(initialMode);
      setVideoExporting(false);
    }
  }, [
    plotRef,
    chartReady,
    timestamps,
    mode,
    timestampIndex,
    setTimestampIndex,
    setMode,
    videoExporting,
    waitForPlotRedraw,
  ]);

  return {
    videoExporting,
    videoProgress,
    videoError,
    handleAfterPlot,
    exportFrames,
  };
};
