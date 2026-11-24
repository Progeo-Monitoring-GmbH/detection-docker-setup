/**
 * The interaction modes of the plan canvas (ImageCanvasStage) - what is
 * possible with the props given, what a held key / the edit mode does, and
 * the texts that tell it (badge, cursor, tooltip, the bars). Pure.
 */
import { bandMeters, finite, type MarkerItem, type PlanImage } from './imageCanvasGeometry';

/** Click tools: pan (default), place the metric reference point, or pick
 * the two points of a known distance for the meters-per-pixel calibration
 * (picked only while M is held - plain presses still pan). */
export type CanvasTool = 'pan' | 'reference' | 'calibrate';
/** Held keys that change what a press on the plan does: A drags sensors to
 * align, R sets the reference point, M picks a calibration point; D / O / L
 * + drag select measure points to remove / cut out / align as a group, and
 * I + click inserts the cut ones. F fits (tapped: the selection or the plan,
 * + drag: that area), Space + drag pans. */
export type HeldKey = 'a' | 'r' | 'm' | 'd' | 'o' | 'l' | 'i' | 'f' | 'space';
export const HELD_KEYS: HeldKey[] = ['a', 'r', 'm', 'd', 'o', 'l', 'i', 'f', 'space'];
/** The keys of the view (fit, pan) - they work in every mode, "Repair order" too. */
export const VIEW_KEYS: HeldKey[] = ['f', 'space'];
/** Edits of the plan image, switched on by a key press: C fills the selected
 * area white, X crops the plan to it - each only once "Apply" is pressed. */
export type ImageEdit = 'clear' | 'crop';
export const EDIT_KEYS: Record<string, ImageEdit> = { c: 'clear', x: 'crop' };
/** What measure points selected with a held key + drag are for. */
export type PointSelect = 'remove' | 'cut' | 'group';
const SELECT_KEYS: Partial<Record<HeldKey, PointSelect>> = { d: 'remove', o: 'cut', l: 'group' };
/** What a selected area is for: an image edit, or the measure points in it. */
export type SelectMode = ImageEdit | PointSelect;

/** A sensor placed by hand (Lageplan wizard), normalized like nx/ny. */
export type PlacedSensor = {
  deviceId: number;
  label: string;
  nx: number;
  ny: number;
};

/** Placing sensors by hand: a click on the plan places the active device,
 * placed sensors can be dragged. Shown instead of the measure points. */
export type SensorPlacement = {
  sensors: PlacedSensor[];
  activeDeviceId: number | null;
  activeLabel?: string;
  onPlace: (nx: number, ny: number) => void;
  onMove: (deviceId: number, nx: number, ny: number) => void;
  onSelect: (deviceId: number) => void;
};

/** Every key of the canvas has its colour: its badge, its selection and the
 * glow of the canvas' frame while it is held / its mode is on. */
export const KEY_COLORS: Record<HeldKey | 'c' | 'x', string> = {
  a: '#0d6efd',
  r: '#0aa2c0',
  m: '#198754',
  d: '#C44D26',
  o: '#B7791F',
  l: '#6f42c1',
  i: '#d63384',
  f: '#e0a100',
  c: '#5c6b7a',
  x: '#212529',
  space: '#8e9aa6',
};
/** Colours of the point actions: remove, cut out / insert, group alignment. */
export const REMOVE_COLOR = KEY_COLORS.d;
export const CUT_COLOR = KEY_COLORS.o;
export const GROUP_COLOR = KEY_COLORS.l;
export const PRIMARY_COLOR = KEY_COLORS.a;
const SELECT_COLORS: Record<SelectMode, string> = {
  remove: REMOVE_COLOR,
  cut: CUT_COLOR,
  group: GROUP_COLOR,
  clear: KEY_COLORS.c,
  crop: KEY_COLORS.x,
};

/** What D / O / L + drag do, for the badge and the button under the selection. */
const POINT_ACTIONS: Record<PointSelect, { name: string; doing: string; button: string }> = {
  remove: { name: 'Remove', doing: 'to remove', button: 'Remove' },
  cut: { name: 'Cut out', doing: 'to cut out - insert them with I', button: 'Cut' },
  group: { name: 'Align a group', doing: 'to align by themselves', button: 'Align' },
};

/** The measure point selection an edit mode is (D / O / L), or null for an image edit. */
export const pointSelectOf = (mode: SelectMode | null): PointSelect | null =>
  mode === 'remove' || mode === 'cut' || mode === 'group' ? mode : null;

/** The colour of a selection (outline, marks): its key's (D / O / L / C / X). */
export const selectColorOf = (mode: SelectMode | null) => (mode ? SELECT_COLORS[mode] : REMOVE_COLOR);

/** What the canvas offers with the props given. */
export type CanvasCaps = {
  /** Point calibration (hold A) with the sliders' panel, not while placing sensors. */
  canAlign: boolean;
  /** Auto alignment of a stored plan's points onto its orange lines. */
  canAutoAlign: boolean;
  /** Reference point and calibration with the scale panel. */
  canScale: boolean;
  /** Clearing / cropping / rotating the image of a stored plan. */
  canEditImage: boolean;
  canRemovePoints: boolean;
  canCut: boolean;
  /** Inserting cut points and aligning a group are stored on this plan. */
  canPlace: boolean;
  canGroup: boolean;
  canInsert: boolean;
};

export const canvasCaps = (input: {
  withSliders: boolean;
  placing: boolean;
  hasImage: boolean;
  itemCount: number;
  cutCount: number;
  alignPins: number;
  locationId?: number;
  lageplanId?: number;
  onSaveScale?: unknown;
  onImageEdited?: unknown;
  onPointsRemoved?: unknown;
  onCut?: unknown;
  onPointsPlaced?: unknown;
}): CanvasCaps => {
  const panel = input.withSliders && input.hasImage;
  const storedPlan = input.locationId != null && input.lageplanId != null;
  const alignable = panel && !input.placing;
  // Editing stored measure points (D / O / L / I) - not while placing by hand.
  const pointsEditable = alignable && input.locationId != null;
  const hasItems = input.itemCount > 0;
  const canPlace = pointsEditable && input.onPointsPlaced != null && input.lageplanId != null;
  return {
    canAlign: alignable && input.itemCount >= input.alignPins,
    canAutoAlign: alignable && hasItems && storedPlan,
    canScale: panel && input.onSaveScale != null,
    canEditImage: panel && input.onImageEdited != null && storedPlan,
    canRemovePoints: pointsEditable && input.onPointsRemoved != null && hasItems,
    canCut: pointsEditable && input.onCut != null && hasItems,
    canPlace,
    canGroup: canPlace && hasItems,
    canInsert: canPlace && input.cutCount > 0,
  };
};

/** Whether a selection for `mode` can be made. */
export const canSelect = (caps: CanvasCaps, mode: SelectMode) => {
  const point: Record<PointSelect, boolean> = {
    remove: caps.canRemovePoints,
    cut: caps.canCut,
    group: caps.canGroup,
  };
  return pointSelectOf(mode) ? point[mode as PointSelect] : caps.canEditImage;
};

/** The state the badge, cursor and key legend tell. */
export type CanvasModes = {
  caps: CanvasCaps;
  heldKey: HeldKey | null;
  tool: CanvasTool;
  editMode: SelectMode | null;
  /** The selection can be applied (big enough) / is still being dragged. */
  hasSelection: boolean;
  selecting: boolean;
  selectedCount: number;
  cutCount: number;
  group: { size: number; pins: number } | null;
  /** The point calibration (A) has pins or a drag. */
  aligning: boolean;
  lineMode: boolean;
  calibrationCount: number;
};

/** A group alignment (L) as the modes tell it: its size and pins. */
export const groupSummary = (group: { ids: Set<number>; pins: unknown[] } | null) =>
  group ? { size: group.ids.size, pins: group.pins.length } : null;

/** The edit mode, if it can be used. */
export const editingOf = (modes: CanvasModes) => modes.editMode != null && canSelect(modes.caps, modes.editMode);

/** A held D / O / L that can select now. */
const heldSelectOf = (modes: CanvasModes): PointSelect | null => {
  const held = modes.heldKey ? SELECT_KEYS[modes.heldKey] : undefined;
  return held && canSelect(modes.caps, held) ? held : null;
};

/** What a press on the plan selects an area for: a held D / O / L (not
 * while aligning), else the edit mode on - nothing during a group alignment. */
export const pressSelectMode = (modes: CanvasModes): SelectMode | null => {
  if (modes.group) {
    return null;
  }
  const held = heldSelectOf(modes);
  return held && !modes.aligning ? held : modes.editMode;
};

/** I held with cut points to insert. */
export const insertingOf = (modes: CanvasModes) => modes.heldKey === 'i' && modes.caps.canInsert;

/** A held, with a calibration possible. */
export const alignKeyOf = (modes: CanvasModes) => modes.heldKey === 'a' && modes.caps.canAlign;

export const pointNounOf = (lineMode: boolean) => (lineMode ? 'dm sensor' : 'measure point');

const pointBadge = (modes: CanvasModes, mode: PointSelect, selected: boolean) => {
  const noun = pointNounOf(modes.lineMode);
  return selected
    ? `${POINT_ACTIONS[mode].name}: ${modes.selectedCount} ${noun}(s) selected · Esc cancels`
    : `${POINT_ACTIONS[mode].name}: drag over the ${noun}s ${POINT_ACTIONS[mode].doing}`;
};

export type Badge = { text: string; color: string };

const editBadge = (modes: CanvasModes, mode: SelectMode): Badge => {
  if (mode === 'crop') {
    return { text: 'Crop: drag the area to keep · Esc cancels', color: KEY_COLORS.x };
  }
  const pointSelect = pointSelectOf(mode);
  return {
    text: pointSelect
      ? pointBadge(modes, pointSelect, modes.hasSelection && !modes.selecting)
      : 'Clear: drag over the area to fill white · Esc cancels',
    color: selectColorOf(mode),
  };
};

/** The key hints a held key gives (A / R / M, F, Space). */
const heldKeyText = (modes: CanvasModes) => {
  if (modes.heldKey === 'f') {
    return 'Fit: drag over an area to zoom to it - or let go to fit the selection';
  }
  if (modes.heldKey === 'space') {
    return 'Pan: drag to move the plan';
  }
  if (alignKeyOf(modes)) {
    return `Align: drag a ${modes.lineMode ? 'dm line' : 'sensor'} onto its right place`;
  }
  if (!modes.caps.canScale) {
    return null;
  }
  if (modes.heldKey === 'r') {
    return 'Reference point: click it on the plan';
  }
  if (modes.heldKey === 'm') {
    return `Calibrate: click ${modes.calibrationCount === 1 ? 'the second' : 'the first'} point of a known distance`;
  }
  return null;
};

/** What a held key / the edit mode does - the badge on the plan, or null.
 * The canvas' frame glows in its colour. */
export const canvasBadge = (modes: CanvasModes): Badge | null => {
  const noun = pointNounOf(modes.lineMode);
  // The view keys first: they work in every mode.
  if (modes.heldKey === 'f' || modes.heldKey === 'space') {
    return { text: heldKeyText(modes)!, color: KEY_COLORS[modes.heldKey] };
  }
  if (editingOf(modes) && modes.editMode) {
    return editBadge(modes, modes.editMode);
  }
  if (insertingOf(modes)) {
    return { text: `Insert ${modes.cutCount} cut ${noun}(s): click where their middle goes`, color: KEY_COLORS.i };
  }
  if (modes.group) {
    return { text: `Align ${modes.group.size} ${noun}(s): drag them onto their place · Esc cancels`, color: GROUP_COLOR };
  }
  const heldSelect = heldSelectOf(modes);
  if (heldSelect && !modes.aligning) {
    return { text: pointBadge(modes, heldSelect, false), color: SELECT_COLORS[heldSelect] };
  }
  const text = heldKeyText(modes);
  // A held D / O / L while aligning shows no badge (heldKeyText is null for it).
  return text && modes.heldKey ? { text, color: KEY_COLORS[modes.heldKey] } : null;
};

/** The edit mode whose selection can be applied now ("Apply" floats): big
 * enough and let go - else null. */
export const applyModeOf = (modes: CanvasModes) =>
  editingOf(modes) && modes.hasSelection && !modes.selecting ? modes.editMode : null;

const picking = (modes: CanvasModes, placing: boolean) =>
  editingOf(modes) ||
  heldSelectOf(modes) != null ||
  insertingOf(modes) ||
  modes.tool === 'reference' ||
  placing ||
  (modes.caps.canScale && (modes.heldKey === 'r' || modes.heldKey === 'm'));

/** The cursor over the canvas: picking a point / an area, dragging, over a sensor, panning. */
export const canvasCursor = (
  modes: CanvasModes,
  pointer: { placing: boolean; dragging: boolean; hovered: MarkerItem | null; groupIds: Set<number> | null },
) => {
  const { hovered } = pointer;
  if (modes.heldKey === 'space') {
    return pointer.dragging ? 'grabbing' : 'grab';
  }
  if (modes.heldKey === 'f' || picking(modes, pointer.placing)) {
    return 'crosshair';
  }
  if (pointer.dragging) {
    return 'grabbing';
  }
  if (hovered && pointer.groupIds?.has(Number(hovered.point.id))) {
    return 'grab';
  }
  if (alignKeyOf(modes)) {
    return hovered ? 'grab' : 'crosshair';
  }
  return hovered ? 'pointer' : 'grab';
};

/** The floating bar under a selection ("Apply", "Remove N", ...). */
export const applyBarTexts = (
  mode: SelectMode,
  selectingPoints: boolean,
  selectedCount: number,
  lineMode: boolean,
  t: (key: string) => string,
) => {
  const pointSelect = selectingPoints ? pointSelectOf(mode) : null;
  const noun = pointNounOf(lineMode);
  const pointDetail = () => {
    if (selectedCount === 0) {
      return `No ${noun} in the selection - drag again.`;
    }
    // Removing points cannot be undone.
    return pointSelect === 'remove' ? t('image_canvas_remove_irreversible') : 'Esc cancels.';
  };
  const imageMessage = mode === 'crop' ? 'Crop the plan to the selected area' : 'Fill the selected area white';
  const modePoint = pointSelectOf(mode);
  return {
    tone: mode === 'crop' || modePoint === 'cut' || modePoint === 'group' ? ('primary' as const) : ('danger' as const),
    message:
      mode !== 'crop' && pointSelect ? `${POINT_ACTIONS[pointSelect].name}: ${selectedCount} ${noun}(s) selected` : imageMessage,
    // Editing the image (a new file, the old one deleted) cannot be undone.
    detail: selectingPoints ? pointDetail() : t('image_canvas_edit_irreversible'),
    label: pointSelect ? `${POINT_ACTIONS[pointSelect].button} ${selectedCount}` : 'Apply',
    variant: mode === 'crop' ? ('primary' as const) : ('danger' as const),
    // The colour of the point action (cut / group) in use.
    color: modePoint && modePoint !== 'remove' ? selectColorOf(mode) : undefined,
  };
};

/** What the group panel tells about the pins so far. */
export const groupHint = (pins: number, problem: string | null, lineMode: boolean) => {
  if (problem != null && pins) {
    return problem;
  }
  if (pins === 0) {
    return `Drag one of them onto its place - one pin moves the group, two or more far apart also scale it. The plan's alignment and the other ${pointNounOf(lineMode)}s stay.`;
  }
  return pins === 1
    ? 'Moved by the pin. Drag another one, far from the first, to scale them too - or apply.'
    : 'Moved and scaled by the pins. Dragging one again moves its pin.';
};

/** What the point calibration panel tells about the pins so far. */
export const alignHint = (pins: number, minPins: number, problem: string | null, errorPx: number | null, lineMode: boolean) => {
  if (problem && pins >= minPins) {
    return problem;
  }
  return errorPx != null
    ? `Computed from the pins (stored) - off by at most ${errorPx.toFixed(1)} px of the plan. Hold A and drag more to refine.`
    : `Hold A and drag one more ${lineMode ? 'dm line' : 'sensor'} onto its place, far from the first. Dragging one again moves its pin.`;
};

type TooltipInfo = {
  deviceLabels?: Record<number, string>;
  devicePairStarts?: Record<number, number>;
  image: PlanImage | null;
  metersPerPixel: number | null;
  alignment: { scaleX: number; scaleY: number };
  lineMode: boolean;
};

const deviceRows = (item: MarkerItem, info: TooltipInfo): Array<[string, string]> => {
  if (item.point.device == null) {
    return [];
  }
  const deviceId = Number(item.point.device);
  const rows: Array<[string, string]> = [['Device', info.deviceLabels?.[deviceId] ?? `#${deviceId}`]];
  // Which pair of the device's measurements is this sensor.
  const start = info.devicePairStarts?.[deviceId];
  if (start != null) {
    rows.push(['Pair', String(Number(item.label) - start + 1)]);
  }
  return rows;
};

const bandRows = (item: MarkerItem, info: TooltipInfo): Array<[string, string]> => {
  const { point, end } = item;
  if (!end) {
    return info.lineMode ? [['Band', 'not in the plan - shown at its label']] : [];
  }
  if (info.image && info.metersPerPixel) {
    // Meters per pixel of the plan image, the band as the plan shows it.
    const meters = bandMeters({ start: item.start, end }, info.image, info.alignment, info.metersPerPixel);
    return [['Length', `${meters.toFixed(1)} m`]];
  }
  // x/y are CAD coordinates times 10 (cad_reader.normalize_points).
  const length = Math.hypot(finite(point.x_end) - finite(point.x), finite(point.y_end) - finite(point.y)) / 10;
  return Number.isFinite(length) ? [['Length', `${length.toFixed(1)} CAD units`]] : [];
};

/** What the tooltip of a measure point / dm line tells. */
export const tooltipRows = (item: MarkerItem, info: TooltipInfo): Array<[string, string]> => {
  const { point } = item;
  const optional = (label: string, value: unknown): Array<[string, string]> =>
    value != null ? [[label, String(value)]] : [];
  return [
    ...(point.name ? ([['Name', String(point.name)]] as Array<[string, string]>) : []),
    ...deviceRows(item, info),
    ...bandRows(item, info),
    ...optional('Threshold', point.threshold),
    ...optional('Last value', point.last_value),
  ];
};
