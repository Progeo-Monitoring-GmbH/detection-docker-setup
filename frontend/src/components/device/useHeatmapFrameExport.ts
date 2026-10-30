import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { getBackendUrl } from '../../backendUrl';
import { downloadBlob } from '../../download';
import { buildStoredZip } from './frameZip';
import {
  canvasToPngBlob,
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

type RenderResult = { state?: string; ready?: boolean; url?: string; error?: string };

/** Indices of the exported frames: every n-th timestamp (at most
 * MAX_FRAMES), always ending with the last one. */
export const exportFrameIndices = (count: number) => {
  const step = Math.max(1, Math.ceil(count / MAX_FRAMES));
  const indices: number[] = [];
  for (let index = 0; index < count; index += step) {
    indices.push(index);
  }
  if (count > 0 && indices[indices.length - 1] !== count - 1) {
    indices.push(count - 1);
  }
  return indices;
};

/** Video size: the heatmap's size on screen, within 320x240 and 1280x720. */
export const exportFrameSize = (size: { width: number; height: number }) => ({
  width: Math.min(Math.max(Math.round(size.width) || 960, 320), 1280),
  height: Math.min(Math.max(Math.round(size.height) || 540, 240), 720),
});

/** The frames as frames/frame_0001.png ... in a store-only ZIP. */
const zipFrames = async (frames: Blob[]) =>
  buildStoredZip(
    await Promise.all(
      frames.map(async (blob, index) => ({
        name: `frames/frame_${String(index + 1).padStart(4, '0')}.png`,
        data: new Uint8Array(await blob.arrayBuffer()),
      })),
    ),
  );

/**
 * A poll of the render task: the result's URL once it is ready, null while it
 * is still running. Throws when rendering failed or the task is still
 * PENDING after PENDING_TIMEOUT_MS (never picked up by a worker).
 */
export const renderResultUrl = (
  result: RenderResult,
  waitedMs: number,
  t: (key: string) => string,
) => {
  if (result.ready) {
    if (result.url) {
      return result.url;
    }
    throw new Error(result.error || t('heatmap_video_error_render'));
  }
  if (result.state === 'PENDING' && waitedMs > PENDING_TIMEOUT_MS) {
    throw new Error(t('heatmap_video_error_no_worker'));
  }
  return null;
};

const requestErrorMessage = (error: unknown, fallback: string) => {
  const response = (error as { response?: { data?: { reason?: string } } })
    ?.response;
  return response?.data?.reason || (error as Error)?.message || fallback;
};

type Auth = ReturnType<typeof useAuth>;
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A GET as a promise of its data; a failure rejects with the backend's
 * reason, else `fallback`. */
const getData = <T>(auth: Auth, url: string, fallback: string, config = {}) =>
  new Promise<T>((resolve, reject) => {
    void axiosConfig.perform_get(
      auth,
      url,
      (response) => resolve(response?.data as T),
      (error) => reject(new Error(requestErrorMessage(error, fallback))),
      config,
    );
  });

/** Uploads the frames ZIP; resolves with the render task's id - or, when the
 * same frames were rendered before, the result's media URL right away. */
const startRendering = (auth: Auth, upload: FormData, t: Translate) =>
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
      (error) => reject(new Error(requestErrorMessage(error, t('heatmap_video_error_upload')))),
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
  });

/** Polls the render task; resolves with the result ZIP's media URL. */
const waitForResult = async (auth: Auth, taskId: string, t: Translate) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < RESULT_TIMEOUT_MS) {
    await sleep(RESULT_POLL_MS);
    const result = await getData<RenderResult | undefined>(
      auth,
      `/v1/location/heatmap_video_result/?task_id=${encodeURIComponent(taskId)}`,
      t('heatmap_video_error_poll'),
    );
    const url = renderResultUrl(result ?? {}, Date.now() - startedAt, t);
    if (url) {
      return url;
    }
  }
  throw new Error(t('heatmap_video_error_timeout'));
};

/** Downloads the result ZIP (frames + MP4) and saves it. */
const saveResult = async (auth: Auth, url: string, t: Translate) => {
  const zipBlob = await getData<Blob>(auth, getBackendUrl(url), t('heatmap_video_error_download'), {
    responseType: 'blob',
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadBlob(zipBlob, `sensor-heatmap-${stamp}.zip`);
};

/**
 * Captures the frames at `indices` as PNGs: moves the slider to each one
 * (`showFrame` resolves once it is drawn), draws it onto a white background
 * - frames don't render black on dark video players - with its timestamp
 * label, and reports the progress (0..1).
 */
const captureFrames = async ({
  indices,
  timestamps,
  size: { width, height },
  startIndex,
  showFrame,
  captureFrame,
  onProgress,
  t,
}: {
  indices: number[];
  timestamps: number[];
  size: { width: number; height: number };
  /** The frame shown when the export starts. */
  startIndex: number;
  showFrame: (index: number) => Promise<unknown>;
  captureFrame: (width: number, height: number) => HTMLCanvasElement | null;
  onProgress: (progress: number) => void;
  t: Translate;
}) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(t('heatmap_video_error_canvas'));
  }
  const blobs: Blob[] = [];
  let shown = startIndex;
  for (const [frame, index] of indices.entries()) {
    if (index !== shown) {
      await showFrame(index);
      shown = index;
    }
    const frameCanvas = captureFrame(width, height);
    if (!frameCanvas) {
      throw new Error(t('heatmap_video_error_canvas'));
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(frameCanvas, 0, 0, width, height);
    drawFrameLabel(ctx, width, height, timestamps[index], frame + 1, indices.length, t('heatmap_video_frame_label'));
    const blob = await canvasToPngBlob(canvas);
    if (blob) {
      blobs.push(blob);
    }
    // Let the browser breathe between frames so the progress UI updates.
    await sleep(FRAME_SLEEP_MS);
    onProgress((frame + 1) / indices.length);
  }
  return blobs;
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

  /** Shows the frame and resolves once it is drawn (at most 400 ms later). */
  const showFrame = useCallback(
    (index: number) => {
      setTimestampIndex(index);
      return Promise.race([
        new Promise<void>((resolve) => {
          afterPlotResolvers.current.push(resolve);
        }),
        sleep(400),
      ]);
    },
    [setTimestampIndex],
  );

  const handleAfterPlot = useCallback(() => {
    const resolve = afterPlotResolvers.current.shift();
    resolve?.();
  }, []);

  const downloadVideoResult = useCallback(async () => {
    if (!videoResultUrl) {
      return;
    }
    setVideoError(null);
    try {
      await saveResult(auth, videoResultUrl, t);
    } catch (error) {
      setVideoError((error as Error).message || t('heatmap_video_error_download'));
    }
  }, [auth, videoResultUrl, t]);

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

    // The animation walks the timestamp slider; the previous position is
    // restored afterwards.
    const initialIndex = timestampIndex;
    try {
      const frames = await captureFrames({
        indices: exportFrameIndices(timestamps.length),
        timestamps,
        size: exportFrameSize(size),
        startIndex: initialIndex,
        showFrame,
        captureFrame,
        onProgress: setVideoProgress,
        t,
      });
      if (!frames.length) {
        throw new Error(t('heatmap_video_error_no_frames'));
      }
      const framesZip = await zipFrames(frames);

      // The plot is no longer needed - restore it while the server renders.
      setTimestampIndex(initialIndex);

      setVideoStage('uploading');
      const upload = new FormData();
      upload.append('frames', framesZip, 'frames.zip');
      upload.append('framerate', String(VIDEO_FRAMERATE));
      const started = await startRendering(auth, upload, t);

      setVideoStage('rendering');
      const resultUrl = started.url ?? (await waitForResult(auth, started.taskId as string, t));

      // Kept so the toolbar can offer the result again in case the
      // browser blocked the automatic download.
      setVideoResultUrl(resultUrl);
      setVideoStage('downloading');
      await saveResult(auth, resultUrl, t);
    } catch (error) {
      setVideoError((error as Error).message || t('heatmap_video_error_failed'));
    } finally {
      setTimestampIndex(initialIndex);
      setVideoExporting(false);
      setVideoStage(null);
    }
  }, [
    auth,
    captureFrame,
    frameSize,
    chartReady,
    timestamps,
    timestampIndex,
    setTimestampIndex,
    videoExporting,
    showFrame,
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
