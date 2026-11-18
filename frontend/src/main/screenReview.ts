/**
 * Screen review (/review/screens/, backend helper/screen_review.py): the
 * full-page screenshots of a build (python manage.py e2e_screenshots) and
 * the comments on them - arrows, areas, whole screens.
 */

export const SCREEN_REVIEW_URL = '/v1/screen-review/';

export type ScreenDevice = 'pc' | 'mobile';
export type ScreenRole = 'user' | 'staff';
export type NoteKind = 'arrow' | 'area' | 'note';
export type NoteAction = 'move' | 'select' | 'remove' | 'bigger' | 'smaller';

export type ScreenRun = {
  run: string;
  created: string;
  images: number;
  notes: number;
};

export type ScreenImage = {
  file: string;
  device: ScreenDevice;
  role: ScreenRole;
  action: string;
  path: string | null;
  viewport: [number, number] | null;
  width: number;
  height: number;
  errors: string[];
};

export type ArrowGeometry = { x1: number; y1: number; x2: number; y2: number };
export type AreaGeometry = { x: number; y: number; w: number; h: number };

export type ScreenNote = {
  id: number;
  run: string;
  image: string;
  kind: NoteKind;
  action: NoteAction;
  comment: string;
  geometry: ArrowGeometry | AreaGeometry | null;
  author: number | null;
  author_name: string | null;
  created: string;
  updated: string;
};

/** A shape being drawn or not saved yet. */
export type DraftShape =
  | { kind: 'arrow'; geometry: ArrowGeometry }
  | { kind: 'area'; geometry: AreaGeometry }
  | { kind: 'note'; geometry: null };

export const NOTE_ACTIONS: NoteAction[] = [
  'move',
  'select',
  'remove',
  'bigger',
  'smaller',
];

/** The colour of each action - the same as the export's (backend ACTION_COLOR). */
export const ACTION_COLORS: Record<NoteAction, string> = {
  move: '#2a78d6',
  select: '#6250d6',
  remove: '#e34948',
  bigger: '#008300',
  smaller: '#eb6834',
};

/** What a new shape most likely asks for. */
export const defaultAction = (kind: NoteKind): NoteAction =>
  kind === 'arrow' ? 'move' : 'select';

/** The height of one part of a screenshot: its window's height (a screen at a time). */
export const sliceHeightOf = (
  image: Pick<ScreenImage, 'viewport' | 'device'>,
) => image.viewport?.[1] ?? (image.device === 'mobile' ? 844 : 900);

export type Slice = { index: number; top: number; height: number };

/** The parts of an image `height` px tall, `sliceHeight` each (the last one shorter). */
export const slicesOf = (height: number, sliceHeight: number): Slice[] => {
  const slices: Slice[] = [];
  for (let top = 0, index = 0; top < height; top += sliceHeight, index += 1) {
    slices.push({ index, top, height: Math.min(sliceHeight, height - top) });
  }
  return slices;
};

/**
 * The image point under the pointer on a part: `rect` is the part's box on
 * screen, `scale` screen px per image px - clamped into the part.
 */
export const imagePointOf = (
  slice: Slice,
  rect: { left: number; top: number; width: number; height: number },
  width: number,
  clientX: number,
  clientY: number,
) => {
  const scale = rect.width / width;
  const x = Math.min(Math.max((clientX - rect.left) / scale, 0), width);
  const y = Math.min(Math.max((clientY - rect.top) / scale, 0), slice.height);
  return { x: Math.round(x), y: Math.round(slice.top + y) };
};

/** The area between two corners, whichever way it was dragged. */
export const areaBetween = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): AreaGeometry => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});

/** A drag this short is a click, not a shape. */
export const MIN_DRAG = 6;

export const isArrow = (
  geometry: ScreenNote['geometry'],
): geometry is ArrowGeometry => geometry != null && 'x1' in geometry;

export const isArea = (
  geometry: ScreenNote['geometry'],
): geometry is AreaGeometry => geometry != null && 'w' in geometry;

/** Screenshots matching the filters, in a stable order (action, device, role). */
export const filterImages = (
  images: ScreenImage[],
  device: ScreenDevice | 'all',
  role: ScreenRole | 'all',
) =>
  images
    .filter(
      (image) =>
        (device === 'all' || image.device === device) &&
        (role === 'all' || image.role === role),
    )
    .sort(
      (a, b) =>
        a.action.localeCompare(b.action) ||
        a.device.localeCompare(b.device) ||
        a.role.localeCompare(b.role),
    );

/** The notes of each image, in their order (= their numbers on the image). */
export const notesByImage = (notes: ScreenNote[]) => {
  const grouped = new Map<string, ScreenNote[]>();
  [...notes]
    .sort((a, b) => a.created.localeCompare(b.created) || a.id - b.id)
    .forEach((note) =>
      grouped.set(note.image, [...(grouped.get(note.image) ?? []), note]),
    );
  return grouped;
};
