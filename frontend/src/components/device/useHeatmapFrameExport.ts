import { useCallback, useRef, useState } from 'react';
import Plotly from 'plotly.js/dist/plotly';

import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { getBackendUrl } from '../../backendUrl';
import { buildStoredZip } from './frameZip';
import {
  canvasToPngBlob,
  downloadBlob,
  drawFrameLabel,
  loadImageFromDataUrl,
  sleep,
} from './heatmapFrames';

export type AggregationMode = 'slice' | 'avg' | 'max';

/** capturing: frames in the browser, rendering: ffmpeg on the server. */
export type VideoExportStage =
  | 'capturing'
  | 'uploading'
  | 'rendering'
  | 'downloading';

const MAX_FRAMES = 120;
const FRAME_SLEEP_MS = 25;
const VIDEO_FRAMERATE = 8;
const RESULT_POLL_MS = 1500;
const RESULT_TIMEOUT_MS = 10 * 60 * 1000;

const requestErrorMessage = (error: unknown, fallback: string) => {
  const response = (error as { response?: { data?: { reason?: string } } })
    ?.response;
  return response?.data?.reason || (error as Error)?.message || fallback;
};

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
  videoStage: VideoExportStage | null;
  /** Progress of the capturing stage (0..1). */
  videoProgress: number;
  videoError: string | null;
  /** Call after the Plot's onAfterPlot fires so frame redraws can be awaited. */
  handleAfterPlot: () => void;
  exportFrames: () => Promise<void>;
};

/**
 * Captures the heatmap animation over all timestamps as PNG frames and has
 * the backend render them into an MP4 (celery task running ffmpeg, see
 * progeo/helper/heatmap_video.py), then downloads the ZIP with the frames and
 * the video - users don't need ffmpeg themselves. Frames are captured from
 * the plot itself via Plotly.toImage, drawn onto a canvas with a white
 * background and the frame's timestamp label, and stored as lossless PNGs.
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
  const auth = useAuth();
  const [videoExporting, setVideoExporting] = useState(false);
  const [videoStage, setVideoStage] = useState<VideoExportStage | null>(null);
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

  /** Uploads the frames ZIP and returns the render task's id. */
  const startRendering = useCallback(
    (upload: FormData) =>
      new Promise<string>((resolve, reject) => {
        void axiosConfig.perform_post(
          auth,
          '/v1/location/heatmap_video/',
          upload,
          (response) => {
            const taskId = response?.data?.task_id;
            if (taskId) {
              resolve(String(taskId));
            } else {
              reject(new Error('The server did not start the video rendering.'));
            }
          },
          (error) =>
            reject(
              new Error(requestErrorMessage(error, 'Uploading the frames failed.')),
            ),
          { headers: { 'Content-Type': 'multipart/form-data' } },
        );
      }),
    [auth],
  );

  /** Polls the render task; resolves with the result ZIP's media URL. */
  const waitForResult = useCallback(
    async (taskId: string) => {
      const deadline = Date.now() + RESULT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(RESULT_POLL_MS);
        const result = await new Promise<{
          ready?: boolean;
          url?: string;
          error?: string;
        }>((resolve, reject) => {
          void axiosConfig.perform_get(
            auth,
            `/v1/location/heatmap_video_result/?task_id=${encodeURIComponent(taskId)}`,
            (response) => resolve(response?.data ?? {}),
            (error) =>
              reject(
                new Error(
                  requestErrorMessage(error, 'Checking the video rendering failed.'),
                ),
              ),
          );
        });
        if (result.ready) {
          if (result.url) {
            return result.url;
          }
          throw new Error(result.error || 'The video rendering failed.');
        }
      }
      throw new Error('The video rendering took too long.');
    },
    [auth],
  );

  const downloadResult = useCallback(
    (url: string) =>
      new Promise<Blob>((resolve, reject) => {
        void axiosConfig.perform_get(
          auth,
          getBackendUrl(url),
          (response) => resolve(response.data as Blob),
          (error) =>
            reject(
              new Error(requestErrorMessage(error, 'Downloading the video failed.')),
            ),
          { responseType: 'blob' },
        );
      }),
    [auth],
  );

  const exportFrames = useCallback(async () => {
    const gd = plotRef.current;
    if (!gd || !chartReady || timestamps.length < 2 || videoExporting) {
      return;
    }

    setVideoExporting(true);
    setVideoStage('capturing');
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

      // The plot is no longer needed - restore it while the server renders.
      setTimestampIndex(initialIndex);
      setMode(initialMode);

      setVideoStage('uploading');
      const upload = new FormData();
      upload.append('frames', buildStoredZip(frameFiles), 'frames.zip');
      upload.append('framerate', String(VIDEO_FRAMERATE));
      const taskId = await startRendering(upload);

      setVideoStage('rendering');
      const resultUrl = await waitForResult(taskId);

      setVideoStage('downloading');
      const zipBlob = await downloadResult(resultUrl);
      downloadBlob(
        zipBlob,
        `sensor-heatmap-${new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, '-')}.zip`,
      );
    } catch (error) {
      setVideoError((error as Error).message || 'Video export failed.');
    } finally {
      setTimestampIndex(initialIndex);
      setMode(initialMode);
      setVideoExporting(false);
      setVideoStage(null);
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
    startRendering,
    waitForResult,
    downloadResult,
  ]);

  return {
    videoExporting,
    videoStage,
    videoProgress,
    videoError,
    handleAfterPlot,
    exportFrames,
  };
};
