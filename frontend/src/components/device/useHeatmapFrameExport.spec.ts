import { describe, expect, it } from 'vitest';
import { exportFrameIndices, exportFrameSize, renderResultUrl } from './useHeatmapFrameExport';

const t = (key: string) => key;

describe('exportFrameIndices', () => {
  it('takes every frame up to the maximum', () => {
    expect(exportFrameIndices(4)).toEqual([0, 1, 2, 3]);
  });

  it('thins out long animations and always ends with the last frame', () => {
    const indices = exportFrameIndices(1000);
    expect(indices.length).toBeLessThanOrEqual(121);
    expect(indices.slice(0, 3)).toEqual([0, 9, 18]);
    expect(indices[indices.length - 1]).toBe(999);
  });
});

describe('exportFrameSize', () => {
  it('keeps the screen size within 320x240 and 1280x720', () => {
    expect(exportFrameSize({ width: 800.4, height: 500 })).toEqual({ width: 800, height: 500 });
    expect(exportFrameSize({ width: 100, height: 100 })).toEqual({ width: 320, height: 240 });
    expect(exportFrameSize({ width: 4000, height: 3000 })).toEqual({ width: 1280, height: 720 });
    expect(exportFrameSize({ width: 0, height: 0 })).toEqual({ width: 960, height: 540 });
  });
});

describe('renderResultUrl', () => {
  it('is the url once ready, null while running', () => {
    expect(renderResultUrl({ ready: true, url: '/media/x.zip' }, 0, t)).toBe('/media/x.zip');
    expect(renderResultUrl({ state: 'STARTED' }, 999_999, t)).toBeNull();
    expect(renderResultUrl({ state: 'PENDING' }, 1000, t)).toBeNull();
  });

  it('fails on a render error or a task no worker picked up', () => {
    expect(() => renderResultUrl({ ready: true, error: 'ffmpeg' }, 0, t)).toThrow('ffmpeg');
    expect(() => renderResultUrl({ ready: true }, 0, t)).toThrow('heatmap_video_error_render');
    expect(() => renderResultUrl({ state: 'PENDING' }, 60_000, t)).toThrow('heatmap_video_error_no_worker');
  });
});
