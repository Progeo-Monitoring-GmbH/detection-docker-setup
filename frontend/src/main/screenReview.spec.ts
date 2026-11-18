import { describe, expect, it } from 'vitest';
import {
  areaBetween,
  defaultAction,
  filterImages,
  imagePointOf,
  notesByImage,
  sliceHeightOf,
  slicesOf,
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

it('filters by device and user, ordered by screen', () => {
  const images = [
    image('pc-staff-map.png', 'pc', 'staff', 'map'),
    image('mobile-user-login.png', 'mobile', 'user', 'login'),
    image('pc-user-login.png', 'pc', 'user', 'login'),
  ];

  expect(filterImages(images, 'all', 'all').map((entry) => entry.file)).toEqual(
    ['mobile-user-login.png', 'pc-user-login.png', 'pc-staff-map.png'],
  );
  expect(filterImages(images, 'pc', 'user').map((entry) => entry.file)).toEqual(
    ['pc-user-login.png'],
  );
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
