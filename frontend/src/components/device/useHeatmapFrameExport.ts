import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { getBackendUrl } from '../../backendUrl';
import { buildStoredZip } from './frameZip';
import {
  canvasToPngBlob,
  downloadBlob,
  drawFrameLabel,
  sleep,
} from './heatmapFrames';

/** capturing: frames in the browser, rendering: ffmpeg on the server. */
export type VideoExportStage =
  'capturing' | 'uploading' | 'rendering' | 'downloading';

const MAX_FRAMES = 120;
const FRAME_SLEEP_MS = 5;
const VIDEO_FRAMERATE = 4;
const RESULT_POLL_MS = 1500;
const RESULT_TIMEOUT_MS = 10 * 60 * 1000;
// A task still PENDING after this long was never picked up by a worker.
const PENDING_TIMEOUT_MS = 30 * 1000;

const requestErrorMessage = (error: unknown, fallback: string) => {
  const response = (error as { response?: { data?: { reason?: string } } })
    ?.response;
  return response?.data?.reason || (error as Error)?.message || fallback;
};

type UseHeatmapFrameExportOptions = {
  /** Draws the current heatmap (timestamp, zoom) into a new canvas of the
   * given size - one video frame. */
  captureFrame: (width: number, height: number) => HTMLCanvasElement | null;
  /** Size of the heatmap on screen; the frames keep its aspect ratio. */
  frameSize: () => { width: number; height: number } | null;
  /** Whether a chart is currently rendered (false -> export is disabled). */
  chartReady: boolean;
  timestamps: number[];
  timestampIndex: number;
  setTimestampIndex: (index: number) => void;
};

type HeatmapFrameExport = {
  videoExporting: boolean;
  videoStage: VideoExportStage | null;
  /** Progress of the capturing stage (0..1). */
  videoProgress: number;
  /** Media URL of the last rendered ZIP (frames + MP4), for re-downloading. */
  videoResultUrl: string | null;
  downloadVideoResult: () => Promise<void>;
  videoError: string | null;
  /** Call once the heatmap has drawn a new timestamp, so frame redraws can be awaited. */
  handleAfterPlot: () => void;
  exportFrames: () => Promise<void>;
};

/**
 * Captures the heatmap animation over all timestamps as PNG frames and has
 * the backend render them into an MP4 (celery task running ffmpeg, see
 * progeo/helper/heatmap_video.py), then downloads the ZIP with the frames and
 * the video - users don't need ffmpeg themselves. Frames are drawn by the
 * heatmap itself (captureFrame, the current zoom included) onto a canvas with
 * a white background and the frame's timestamp label, and stored as
 * lossless PNGs.
 */
export const useHeatmapFrameExport = ({
  captureFrame,
  frameSize,
  chartReady,
  timestamps,
  timestampIndex,
  setTimestampIndex,
}: UseHeatmapFrameExportOptions): HeatmapFrameExport => {
  const auth = useAuth();
  const { t } = useTranslation();
  const [videoExporting, setVideoExporting] = useState(false);
  const [videoStage, setVideoStage] = useState<VideoExportStage | null>(null);
  const [videoResultUrl, setVideoResultUrl] = useState<string | null>(null);
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

  /** Uploads the frames ZIP; returns the render task's id - or, when the
   * same frames were rendered before, the result's media URL right away. */
  const startRendering = useCallback(
    (upload: FormData) =>
      new Promise<{ taskId?: string; url?: string }>((resolve, reject) => {
        void axiosConfig.perform_post(
          auth,
          '/v1/location/heatmap_video/',
          upload,
          (response) => {
            const taskId = response?.data?.task_id;
            const url = response?.data?.url;
            if (url) {
              resolve({ url: String(url) });
            } else if (taskId) {
              resolve({ taskId: String(taskId) });
            } else {
              reject(new Error(t('heatmap_video_error_not_started')));
            }
          },
          (error) =>
            reject(
              new Error(
                requestErrorMessage(error, t('heatmap_video_error_upload')),
              ),
            ),
          { headers: { 'Content-Type': 'multipart/form-data' } },
        );
      }),
    [auth, t],
  );

  /** Polls the render task; resolves with the result ZIP's media URL. */
  const waitForResult = useCallback(
    async (taskId: string) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < RESULT_TIMEOUT_MS) {
        await sleep(RESULT_POLL_MS);
        const result = await new Promise<{
          state?: string;
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
                  requestErrorMessage(error, t('heatmap_video_error_poll')),
                ),
              ),
          );
        });
        if (result.ready) {
          if (result.url) {
            return result.url;
          }
          throw new Error(result.error || t('heatmap_video_error_render'));
        }
        if (
          result.state === 'PENDING' &&
          Date.now() - startedAt > PENDING_TIMEOUT_MS
        ) {
          throw new Error(t('heatmap_video_error_no_worker'));
        }
      }
      throw new Error(t('heatmap_video_error_timeout'));
    },
    [auth, t],
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
              new Error(
                requestErrorMessage(error, t('heatmap_video_error_download')),
              ),
            ),
          { responseType: 'blob' },
        );
      }),
    [auth, t],
  );

  const saveResult = useCallback(
    async (url: string) => {
      const zipBlob = await downloadResult(url);
      downloadBlob(
        zipBlob,
        `sensor-heatmap-${new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/[:T]/g, '-')}.zip`,
      );
    },
    [downloadResult],
  );

  const downloadVideoResult = useCallback(async () => {
    if (!videoResultUrl) {
      return;
    }
    setVideoError(null);
    try {
      await saveResult(videoResultUrl);
    } catch (error) {
      setVideoError(
        (error as Error).message || t('heatmap_video_error_download'),
      );
    }
  }, [videoResultUrl, saveResult, t]);

  const exportFrames = useCallback(async () => {
    const size = frameSize();
    if (!size || !chartReady || timestamps.length < 2 || videoExporting) {
      return;
    }

    setVideoExporting(true);
    setVideoStage('capturing');
    setVideoProgress(0);
    setVideoError(null);
    setVideoResultUrl(null);

    const initialIndex = timestampIndex;
    const frameStep = Math.max(1, Math.ceil(timestamps.length / MAX_FRAMES));
    const frameIndices: number[] = [];
    for (let index = 0; index < timestamps.length; index += frameStep) {
      frameIndices.push(index);
    }
    if (frameIndices[frameIndices.length - 1] !== timestamps.length - 1) {
      frameIndices.push(timestamps.length - 1);
    }

    const width = Math.min(Math.max(Math.round(size.width) || 960, 320), 1280);
    const height = Math.min(Math.max(Math.round(size.height) || 540, 240), 720);

    try {
      // The animation walks the timestamp slider; the previous position is
      // restored afterwards.
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error(t('heatmap_video_error_canvas'));
      }

      const frameBlobs: Blob[] = [];
      let previousIndex = initialIndex;

      for (let frame = 0; frame < frameIndices.length; frame += 1) {
        const frameIndex = frameIndices[frame];
        if (frameIndex !== previousIndex) {
          setTimestampIndex(frameIndex);
          await waitForPlotRedraw();
          previousIndex = frameIndex;
        }

        const frameCanvas = captureFrame(width, height);
        if (!frameCanvas) {
          throw new Error(t('heatmap_video_error_canvas'));
        }

        // Paint a background first to keep the frames from rendering black
        // on dark video players.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(frameCanvas, 0, 0, width, height);
        drawFrameLabel(
          ctx,
          width,
          height,
          timestamps[frameIndex],
          frame + 1,
          frameIndices.length,
          t('heatmap_video_frame_label'),
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
        throw new Error(t('heatmap_video_error_no_frames'));
      }

      const frameFiles = await Promise.all(
        frameBlobs.map(async (blob, index) => ({
          name: `frames/frame_${String(index + 1).padStart(4, '0')}.png`,
          data: new Uint8Array(await blob.arrayBuffer()),
        })),
      );

      // The plot is no longer needed - restore it while the server renders.
      setTimestampIndex(initialIndex);

      setVideoStage('uploading');
      const upload = new FormData();
      upload.append('frames', buildStoredZip(frameFiles), 'frames.zip');
      upload.append('framerate', String(VIDEO_FRAMERATE));
      const started = await startRendering(upload);

      setVideoStage('rendering');
      const resultUrl = started.url ?? (await waitForResult(started.taskId as string));

      // Kept so the toolbar can offer the result again in case the
      // browser blocked the automatic download.
      setVideoResultUrl(resultUrl);
      setVideoStage('downloading');
      await saveResult(resultUrl);
    } catch (error) {
      setVideoError(
        (error as Error).message || t('heatmap_video_error_failed'),
      );
    } finally {
      setTimestampIndex(initialIndex);
      setVideoExporting(false);
      setVideoStage(null);
    }
  }, [
    captureFrame,
    frameSize,
    chartReady,
    timestamps,
    timestampIndex,
    setTimestampIndex,
    videoExporting,
    waitForPlotRedraw,
    startRendering,
    waitForResult,
    saveResult,
    t,
  ]);

  return {
    videoExporting,
    videoStage,
    videoResultUrl,
    downloadVideoResult,
    videoProgress,
    videoError,
    handleAfterPlot,
    exportFrames,
  };
};
