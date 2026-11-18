import { describe, expect, it } from 'vitest';
import {
  ALL_SCREENS,
  areaBetween,
  defaultAction,
  filterImages,
  imagePointOf,
  notesByImage,
  sliceHeightOf,
  slicesOf,
  stepCursor,
  type ScreenImage,
  type ScreenNote,
} from './screenReview';

const image = (
  file: string,
  device: 'pc' | 'mobile',
  role: 'user' | 'staff',
  action: string,
): ScreenImage => ({
  file,
  device,
  role,
  language: file.includes('-en-') ? 'en' : 'de',
  action,
  path: '/',
  viewport: null,
  width: 1440,
  height: 2000,
  errors: [],
});

describe('slicesOf', () => {
  it('cuts a page into parts of a window height, the last one shorter', () => {
    expect(slicesOf(2000, 900)).toEqual([
      { index: 0, top: 0, height: 900 },
      { index: 1, top: 900, height: 900 },
      { index: 2, top: 1800, height: 200 },
    ]);
    expect(slicesOf(900, 900)).toHaveLength(1);
  });

  it('takes the window height of the capture, else the device default', () => {
    expect(sliceHeightOf({ viewport: [390, 700], device: 'mobile' })).toBe(700);
    expect(sliceHeightOf({ viewport: null, device: 'mobile' })).toBe(844);
    expect(sliceHeightOf({ viewport: null, device: 'pc' })).toBe(900);
  });
});

describe('imagePointOf', () => {
  it('maps the pointer on a part to the page, clamped into the part', () => {
    const slice = { index: 1, top: 900, height: 900 };
    // The part shown at a fifth of its size (288 x 180 px).
    const rect = { left: 100, top: 50, width: 288, height: 180 };

    expect(imagePointOf(slice, rect, 1440, 100 + 144, 50 + 90)).toEqual({
      x: 720,
      y: 1350,
    });
    expect(imagePointOf(slice, rect, 1440, 0, 500)).toEqual({ x: 0, y: 1800 });
  });
});

it('makes an area of two corners, dragged any way', () => {
  expect(areaBetween({ x: 300, y: 50 }, { x: 100, y: 250 })).toEqual({
    x: 100,
    y: 50,
    w: 200,
    h: 200,
  });
});

it('suggests moving for an arrow, selecting otherwise', () => {
  expect(defaultAction('arrow')).toBe('move');
  expect(defaultAction('area')).toBe('select');
  expect(defaultAction('note')).toBe('select');
});

describe('filterImages', () => {
  const images = [
    image('pc-staff-de-map.png', 'pc', 'staff', 'map'),
    image('mobile-user-de-login.png', 'mobile', 'user', 'login'),
    image('pc-user-en-login.png', 'pc', 'user', 'login'),
    image('pc-user-de-login.png', 'pc', 'user', 'login'),
  ];
  const files = (list: ScreenImage[]) => list.map((entry) => entry.file);

  it('orders by screen, device, user and language', () => {
    expect(files(filterImages(images, ALL_SCREENS))).toEqual([
      'mobile-user-de-login.png',
      'pc-user-de-login.png',
      'pc-user-en-login.png',
      'pc-staff-de-map.png',
    ]);
  });

  it('filters by device, user and language', () => {
    expect(
      files(
        filterImages(images, { ...ALL_SCREENS, device: 'pc', role: 'user' }),
      ),
    ).toEqual(['pc-user-de-login.png', 'pc-user-en-login.png']);
    expect(
      files(filterImages(images, { ...ALL_SCREENS, language: 'en' })),
    ).toEqual(['pc-user-en-login.png']);
  });

  it('keeps only the commented ones, leaves out the reviewed ones', () => {
    const commented = new Set(['pc-staff-de-map.png', 'pc-user-de-login.png']);
    const reviewed = new Set(['pc-user-de-login.png']);

    expect(
      files(
        filterImages(
          images,
          { ...ALL_SCREENS, commentedOnly: true },
          commented,
          reviewed,
        ),
      ),
    ).toEqual(['pc-user-de-login.png', 'pc-staff-de-map.png']);
    expect(
      files(
        filterImages(
          images,
          { ...ALL_SCREENS, commentedOnly: true, hideReviewed: true },
          commented,
          reviewed,
        ),
      ),
    ).toEqual(['pc-staff-de-map.png']);
  });
});

describe('stepCursor', () => {
  // Three screenshots of 3, 1 and 2 parts.
  const parts = (index: number) => [3, 1, 2][index];
  const step = (
    index: number,
    part: number,
    move: Parameters<typeof stepCursor>[1],
  ) => stepCursor({ index, part }, move, 3, parts);

  it('goes through the parts, at the last one on to the next screenshot', () => {
    expect(step(0, 0, 'nextPart')).toEqual({ index: 0, part: 1 });
    expect(step(0, 2, 'nextPart')).toEqual({ index: 1, part: 0 });
    expect(step(2, 1, 'nextPart')).toEqual({ index: 2, part: 1 });
  });

  it('goes back, at the first part to the last part of the previous screenshot', () => {
    expect(step(0, 2, 'previousPart')).toEqual({ index: 0, part: 1 });
    expect(step(2, 0, 'previousPart')).toEqual({ index: 1, part: 0 });
    expect(step(1, 0, 'previousPart')).toEqual({ index: 0, part: 2 });
    expect(step(0, 0, 'previousPart')).toEqual({ index: 0, part: 0 });
  });

  it('jumps a screenshot up or down, to its first part', () => {
    expect(step(0, 2, 'nextScreen')).toEqual({ index: 1, part: 0 });
    expect(step(2, 1, 'previousScreen')).toEqual({ index: 1, part: 0 });
    expect(step(2, 1, 'nextScreen')).toEqual({ index: 2, part: 1 });
  });

  it('copes with an empty list and a cursor out of range', () => {
    expect(stepCursor({ index: 4, part: 9 }, 'nextPart', 0, parts)).toEqual({
      index: 0,
      part: 0,
    });
    expect(step(7, 9, 'nextPart')).toEqual({ index: 2, part: 1 });
  });
});

it('numbers the notes of an image in the order they were made', () => {
  const note = (id: number, file: string, created: string) =>
    ({ id, image: file, created }) as ScreenNote;

  const grouped = notesByImage([
    note(3, 'a.png', '2026-11-18T10:00'),
    note(1, 'a.png', '2026-11-18T09:00'),
    note(2, 'b.png', '2026-11-18T08:00'),
  ]);

  expect(grouped.get('a.png')?.map((entry) => entry.id)).toEqual([1, 3]);
  expect(grouped.get('b.png')?.map((entry) => entry.id)).toEqual([2]);
});
