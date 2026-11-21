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

export type ScreenLanguage = 'de' | 'en';

/**
 * A step of a dialog's way to open (frontend/e2e/screenshots/routes.mjs):
 * an element by its test id (and data-test-key) or a CSS selector.
 */
export type ModalStep = {
  do:
    | 'click'
    | 'check'
    | 'uncheck'
    | 'hover'
    | 'fill'
    | 'select'
    | 'upload'
    | 'press'
    | 'wait';
  testId?: string;
  key?: string;
  css?: string;
  value?: string;
  /** The file uploaded (its name). */
  file?: string;
  /** The point of the element clicked (a plot). */
  position?: { x: number; y: number };
  ms?: number;
  /** Only on this device (e.g. a phone table's row expander). */
  device?: ScreenDevice;
  /** Only for this role (e.g. a switch only staff have). */
  role?: ScreenRole;
};

/** The dialog a screenshot shows, opened on its page. */
export type ScreenModal = {
  name: string;
  /** data-testid of the dialog - null on a run without a manifest entry. */
  testId: string | null;
  path: string | null;
  /** A variant of the mocked data (mockApi.mjs SCENARIOS). */
  scenario: string | null;
  steps: ModalStep[];
};

export type ScreenImage = {
  file: string;
  device: ScreenDevice;
  role: ScreenRole;
  language: ScreenLanguage;
  action: string;
  path: string | null;
  /** Where it was taken (path and query) - runs before: missing, the path is it. */
  url?: string | null;
  /** The dialog on the page - null (or missing) for the page itself. */
  modal?: ScreenModal | null;
  viewport: [number, number] | null;
  width: number;
  height: number;
  errors: string[];
};

/** A screenshot the capture could not take (a dialog that did not open). */
export type ScreenFailure = {
  file: string;
  device: ScreenDevice;
  role: ScreenRole;
  language: ScreenLanguage;
  action: string;
  url: string | null;
  modal: ScreenModal | null;
  reason: string;
};

/** The address a screenshot was taken on: its url, else (older runs) its route's path. */
export const imageUrl = (image: Pick<ScreenImage, 'url' | 'path'>) =>
  image.url || image.path || null;

/**
 * A link into the portal for `url` - only a path of this site (no other
 * origin, no "javascript:"), else null.
 */
export const portalHref = (url: string | null | undefined) =>
  url && url.startsWith('/') && !url.startsWith('//') ? url : null;

/** The element a step acts on, readable: "staff-user-edit [2]" or the CSS selector. */
export const stepTarget = (step: ModalStep) =>
  (step.css ??
    `${step.testId ?? '?'}${step.key != null ? ` [${step.key}]` : ''}`) +
  (step.position ? ` @ ${step.position.x},${step.position.y}` : '');

/** The steps that open a dialog on `device` as `role` (the others' steps left out). */
export const stepsFor = (
  modal: ScreenModal,
  device: ScreenDevice,
  role?: ScreenRole,
) =>
  modal.steps.filter(
    (step) =>
      (!step.device || step.device === device) &&
      (!step.role || !role || step.role === role),
  );

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

/**
 * The shortest part worth its own frame: a rest below it is not cut off but
 * stays with the part before (a few px strip of a page is no screen to review).
 */
const MIN_SLICE_HEIGHT = 75;

/**
 * The parts of an image `height` px tall, `sliceHeight` each - the last one
 * shorter, or up to MIN_SLICE_HEIGHT px taller (a shorter rest is not cut off).
 */
export const slicesOf = (height: number, sliceHeight: number): Slice[] => {
  const slices: Slice[] = [];
  for (let top = 0, index = 0; top < height; top += sliceHeight, index += 1) {
    const rest = height - top - sliceHeight;
    if (rest > 0 && rest < MIN_SLICE_HEIGHT) {
      slices.push({ index, top, height: height - top });
      break;
    }
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

/** A screenshot marked as reviewed (POST /v1/screen-review/<run>/reviewed/). */
export type ReviewedMark = {
  image: string;
  reviewed_by: number | null;
  reviewed_by_name: string | null;
  created: string;
};

export type ScreenFilter = {
  device: ScreenDevice | 'all';
  role: ScreenRole | 'all';
  language: ScreenLanguage | 'all';
  /** Pages only, dialogs only (an image with a `modal`) or both. */
  kind: 'all' | 'page' | 'dialog';
  /** Only screenshots with comments. */
  commentedOnly: boolean;
  /** Without the ones marked as reviewed. */
  hideReviewed: boolean;
};

export const ALL_SCREENS: ScreenFilter = {
  device: 'all',
  role: 'all',
  language: 'all',
  kind: 'all',
  commentedOnly: false,
  hideReviewed: false,
};

/**
 * Screenshots matching the filter, in a stable order: action (the page),
 * the page before its dialogs (by name), then device, role, language.
 */
export const filterImages = (
  images: ScreenImage[],
  filter: ScreenFilter,
  commented: ReadonlySet<string> = new Set(),
  reviewed: ReadonlySet<string> = new Set(),
) =>
  images
    .filter(
      (image) =>
        (filter.device === 'all' || image.device === filter.device) &&
        (filter.role === 'all' || image.role === filter.role) &&
        (filter.language === 'all' || image.language === filter.language) &&
        (filter.kind === 'all' || (filter.kind === 'dialog') === Boolean(image.modal)) &&
        (!filter.commentedOnly || commented.has(image.file)) &&
        (!filter.hideReviewed || !reviewed.has(image.file)),
    )
    .sort(
      (a, b) =>
        a.action.localeCompare(b.action) ||
        (a.modal?.name ?? '').localeCompare(b.modal?.name ?? '') ||
        a.device.localeCompare(b.device) ||
        a.role.localeCompare(b.role) ||
        a.language.localeCompare(b.language),
    );

/** Where the gallery's keyboard / swipe cursor stands: a screenshot and one of its parts. */
export type Cursor = { index: number; part: number };

export type CursorMove =
  'nextPart' | 'previousPart' | 'nextScreen' | 'previousScreen';

/**
 * The cursor after `move` - over `parts(index)` parts of each of `total`
 * screenshots: a part on, at the last part to the next screenshot's first
 * (back: the previous one's last); a screenshot on or back starts at its
 * first part. At the ends it stays.
 */
export const stepCursor = (
  cursor: Cursor,
  move: CursorMove,
  total: number,
  parts: (index: number) => number,
): Cursor => {
  if (total === 0) {
    return { index: 0, part: 0 };
  }
  const index = Math.min(Math.max(cursor.index, 0), total - 1);
  const part = Math.min(
    Math.max(cursor.part, 0),
    Math.max(parts(index) - 1, 0),
  );
  switch (move) {
    case 'nextPart':
      if (part + 1 < parts(index)) {
        return { index, part: part + 1 };
      }
      return index + 1 < total
        ? { index: index + 1, part: 0 }
        : { index, part };
    case 'previousPart':
      if (part > 0) {
        return { index, part: part - 1 };
      }
      return index > 0
        ? { index: index - 1, part: Math.max(parts(index - 1) - 1, 0) }
        : { index, part };
    case 'nextScreen':
      return index + 1 < total
        ? { index: index + 1, part: 0 }
        : { index, part };
    case 'previousScreen':
      return index > 0 ? { index: index - 1, part: 0 } : { index, part };
    default:
      return { index, part };
  }
};

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
