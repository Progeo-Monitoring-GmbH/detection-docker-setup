import { describe, expect, it } from 'vitest';
import {
  ALL_SCREENS,
  areaBetween,
  defaultAction,
  filterImages,
  imagePointOf,
  imageUrl,
  notesByImage,
  portalHref,
  sliceHeightOf,
  slicesOf,
  stepCursor,
  stepTarget,
  stepsFor,
  type ScreenImage,
  type ScreenModal,
  type ScreenNote,
} from './screenReview';

const modal = (name: string): ScreenModal => ({
  name,
  testId: name,
  path: '/staff/',
  scenario: null,
  steps: [
    {
      do: 'click',
      css: '#row-2 [data-testid^="expander-button-"]',
      device: 'mobile',
    },
    { do: 'click', testId: 'staff-user-edit', key: '2' },
  ],
});

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

  it('cuts off no rest shorter than 75 px - it stays with the part before', () => {
    // The login on a phone: 938 px in 844 px windows - a 94 px rest is a part.
    expect(slicesOf(938, 844)).toEqual([
      { index: 0, top: 0, height: 844 },
      { index: 1, top: 844, height: 94 },
    ]);
    // 74 px rest: one part of 918 px.
    expect(slicesOf(918, 844)).toEqual([{ index: 0, top: 0, height: 918 }]);
    // Exactly 75 px is cut.
    expect(slicesOf(919, 844)).toHaveLength(2);
    // Only the last rest - a long page keeps its full parts.
    expect(slicesOf(2 * 844 + 10, 844)).toEqual([
      { index: 0, top: 0, height: 844 },
      { index: 1, top: 844, height: 854 },
    ]);
    // A page shorter than 75 px is still one part.
    expect(slicesOf(40, 844)).toEqual([{ index: 0, top: 0, height: 40 }]);
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

describe('dialogs next to their page', () => {
  const dialog = (file: string, action: string, name: string) => ({
    ...image(file, file.startsWith('pc') ? 'pc' : 'mobile', 'staff', action),
    modal: modal(name),
  });

  it('sorts each page before its dialogs, the dialogs by name', () => {
    const images = [
      dialog('pc-staff-de-staff-admin--staff-user-edit.png', 'staff-admin', 'staff-user-edit'),
      image('pc-staff-de-backup.png', 'pc', 'staff', 'backup'),
      dialog('mobile-staff-de-staff-admin--staff-user-create.png', 'staff-admin', 'staff-user-create'),
      image('pc-staff-de-staff-admin.png', 'pc', 'staff', 'staff-admin'),
      dialog('pc-staff-de-staff-admin--staff-user-create.png', 'staff-admin', 'staff-user-create'),
      image('mobile-staff-de-staff-admin.png', 'mobile', 'staff', 'staff-admin'),
    ];

    const files = (kind: 'page' | 'dialog') =>
      filterImages(images, { ...ALL_SCREENS, kind }).map((entry) => entry.file);
    expect(files('page')).toEqual([
      'pc-staff-de-backup.png',
      'mobile-staff-de-staff-admin.png',
      'pc-staff-de-staff-admin.png',
    ]);
    expect(files('dialog')).toEqual([
      'mobile-staff-de-staff-admin--staff-user-create.png',
      'pc-staff-de-staff-admin--staff-user-create.png',
      'pc-staff-de-staff-admin--staff-user-edit.png',
    ]);
    expect(filterImages(images, ALL_SCREENS).map((entry) => entry.file)).toEqual([
      'pc-staff-de-backup.png',
      'mobile-staff-de-staff-admin.png',
      'pc-staff-de-staff-admin.png',
      'mobile-staff-de-staff-admin--staff-user-create.png',
      'pc-staff-de-staff-admin--staff-user-create.png',
      'pc-staff-de-staff-admin--staff-user-edit.png',
    ]);
  });

  it('takes the url a screenshot was taken on, else (older runs) its path', () => {
    expect(imageUrl({ url: '/device/overview?location=1', path: '/device/overview' })).toBe(
      '/device/overview?location=1',
    );
    expect(imageUrl({ path: '/location/overview/' })).toBe('/location/overview/');
    expect(imageUrl({ url: null, path: null })).toBeNull();
  });

  it('links only to paths of the portal itself', () => {
    expect(portalHref('/location/1/status?view=zeitreihe')).toBe('/location/1/status?view=zeitreihe');
    expect(portalHref('https://staging.progeo.com/')).toBeNull();
    expect(portalHref('//staging.progeo.com/')).toBeNull();
    expect(portalHref('javascript:alert(1)')).toBeNull();
    expect(portalHref(null)).toBeNull();
  });

  it('names each step by its test id and key, or its selector', () => {
    const [expander, edit] = modal('x').steps;
    expect(stepTarget(edit)).toBe('staff-user-edit [2]');
    expect(stepTarget(expander)).toBe('#row-2 [data-testid^="expander-button-"]');
    expect(stepTarget({ do: 'click', testId: 'topbar-account' })).toBe('topbar-account');
    expect(
      stepTarget({ do: 'click', testId: 'measurement-compare-columns-plot', position: { x: 12, y: 120 } }),
    ).toBe('measurement-compare-columns-plot @ 12,120');
  });

  it("leaves out the other device's steps", () => {
    expect(stepsFor(modal('x'), 'pc').map(stepTarget)).toEqual(['staff-user-edit [2]']);
    expect(stepsFor(modal('x'), 'mobile')).toHaveLength(2);
  });

  it("leaves out the other role's steps", () => {
    const computed = {
      ...modal('computed-suspicion-acknowledge-dialog'),
      steps: [
        { do: 'click' as const, testId: 'suspicion-mode-option', key: 'computed', role: 'staff' as const },
        { do: 'click' as const, testId: 'computed-suspicion-acknowledge', key: 'point-1' },
      ],
    };
    expect(stepsFor(computed, 'pc', 'user').map(stepTarget)).toEqual(['computed-suspicion-acknowledge [point-1]']);
    expect(stepsFor(computed, 'pc', 'staff')).toHaveLength(2);
    // Without a role (older callers): every step.
    expect(stepsFor(computed, 'pc')).toHaveLength(2);
  });
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
