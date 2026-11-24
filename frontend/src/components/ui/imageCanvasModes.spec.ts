import { describe, expect, it } from 'vitest';
import type { MarkerItem } from './imageCanvasGeometry';
import { canvasLegendGroups } from './imageCanvasLegend';
import {
  alignHint,
  applyBarTexts,
  applyModeOf,
  groupSummary,
  canSelect,
  canvasBadge,
  canvasCaps,
  canvasCursor,
  CUT_COLOR,
  GROUP_COLOR,
  groupHint,
  KEY_COLORS,
  pressSelectMode,
  REMOVE_COLOR,
  selectColorOf,
  tooltipRows,
  type CanvasCaps,
  type CanvasModes,
} from './imageCanvasModes';

const allCaps: CanvasCaps = {
  canAlign: true,
  canAutoAlign: true,
  canScale: true,
  canEditImage: true,
  canRemovePoints: true,
  canCut: true,
  canPlace: true,
  canGroup: true,
  canInsert: true,
};
const noCaps = Object.fromEntries(Object.keys(allCaps).map((key) => [key, false])) as CanvasCaps;

const modesOf = (overrides: Partial<CanvasModes> = {}): CanvasModes => ({
  caps: allCaps,
  heldKey: null,
  tool: 'pan',
  editMode: null,
  hasSelection: false,
  selecting: false,
  selectedCount: 0,
  cutCount: 0,
  group: null,
  aligning: false,
  lineMode: false,
  calibrationCount: 0,
  ...overrides,
});

const pointer = { placing: false, dragging: false, hovered: null, groupIds: null };
const hoveredItem: MarkerItem = { point: { id: 1 }, label: '1', color: 'red', start: [0, 0], end: null };

describe('canvasCaps', () => {
  const props = {
    withSliders: true,
    placing: false,
    hasImage: true,
    itemCount: 3,
    cutCount: 0,
    alignPins: 2,
    locationId: 5,
    lageplanId: 7,
    onSaveScale: () => {},
    onImageEdited: () => {},
    onPointsRemoved: () => {},
    onCut: () => {},
    onPointsPlaced: () => {},
  };

  it('offers everything with a stored plan, its callbacks and points', () => {
    expect(canvasCaps(props)).toEqual({ ...allCaps, canInsert: false });
    expect(canvasCaps({ ...props, cutCount: 2 }).canInsert).toBe(true);
  });

  it('offers nothing without the sliders or the image', () => {
    expect(canvasCaps({ ...props, withSliders: false })).toEqual(noCaps);
    expect(canvasCaps({ ...props, hasImage: false })).toEqual(noCaps);
  });

  it('keeps the scale and image edits while placing sensors by hand', () => {
    const caps = canvasCaps({ ...props, placing: true });
    expect(caps).toEqual({ ...noCaps, canScale: true, canEditImage: true });
  });

  it('needs a stored plan for image edits and placing points, enough points for aligning', () => {
    const caps = canvasCaps({ ...props, lageplanId: undefined, itemCount: 1 });
    expect(caps.canEditImage).toBe(false);
    expect(caps.canPlace).toBe(false);
    expect(caps.canAutoAlign).toBe(false);
    expect(caps.canAlign).toBe(false);
    expect(caps.canRemovePoints).toBe(true);
  });
});

describe('selecting', () => {
  it('can select for a mode when its action is possible', () => {
    expect(canSelect({ ...noCaps, canCut: true }, 'cut')).toBe(true);
    expect(canSelect({ ...noCaps, canCut: true }, 'remove')).toBe(false);
    expect(canSelect({ ...noCaps, canEditImage: true }, 'crop')).toBe(true);
  });

  it('starts a selection for a held key, else the edit mode - none in a group alignment', () => {
    expect(pressSelectMode(modesOf({ heldKey: 'd', editMode: 'crop' }))).toBe('remove');
    expect(pressSelectMode(modesOf({ heldKey: 'd', editMode: 'crop', aligning: true }))).toBe('crop');
    expect(pressSelectMode(modesOf({ heldKey: 'd', caps: { ...allCaps, canRemovePoints: false } }))).toBeNull();
    expect(pressSelectMode(modesOf({ heldKey: 'o', group: { size: 2, pins: 0 } }))).toBeNull();
  });

  it('offers "Apply" for a usable selection once it is let go', () => {
    expect(applyModeOf(modesOf({ editMode: 'crop', hasSelection: true }))).toBe('crop');
    expect(applyModeOf(modesOf({ editMode: 'crop', hasSelection: true, selecting: true }))).toBeNull();
    expect(applyModeOf(modesOf({ editMode: 'crop', hasSelection: false }))).toBeNull();
    expect(applyModeOf(modesOf({ editMode: 'crop', hasSelection: true, caps: noCaps }))).toBeNull();
    expect(groupSummary({ ids: new Set([1, 2]), pins: [{}] })).toEqual({ size: 2, pins: 1 });
    expect(groupSummary(null)).toBeNull();
  });

  it('colours a selection by what it is for', () => {
    expect(selectColorOf('cut')).toBe(CUT_COLOR);
    expect(selectColorOf('group')).toBe(GROUP_COLOR);
    expect(selectColorOf('clear')).toBe(KEY_COLORS.c);
    expect(selectColorOf('crop')).toBe(KEY_COLORS.x);
  });

  it('gives every key its own colour', () => {
    const colors = Object.values(KEY_COLORS).map((color) => color.toLowerCase());
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe('canvasBadge', () => {
  it('tells the edit mode first', () => {
    expect(canvasBadge(modesOf({ editMode: 'crop', heldKey: 'i', cutCount: 2 }))).toEqual({
      text: 'Crop: drag the area to keep · Esc cancels',
      color: KEY_COLORS.x,
    });
    expect(canvasBadge(modesOf({ editMode: 'remove', hasSelection: true, selectedCount: 2 }))).toEqual({
      text: 'Remove: 2 measure point(s) selected · Esc cancels',
      color: REMOVE_COLOR,
    });
    expect(canvasBadge(modesOf({ editMode: 'cut', hasSelection: true, selecting: true, lineMode: true }))?.text).toBe(
      'Cut out: drag over the dm sensors to cut out - insert them with I',
    );
  });

  it('tells inserting, a group, a held selection key', () => {
    expect(canvasBadge(modesOf({ heldKey: 'i', cutCount: 3 }))).toEqual({
      text: 'Insert 3 cut measure point(s): click where their middle goes',
      color: KEY_COLORS.i,
    });
    expect(canvasBadge(modesOf({ group: { size: 4, pins: 1 } }))?.color).toBe(GROUP_COLOR);
    expect(canvasBadge(modesOf({ heldKey: 'l' }))).toEqual({
      text: 'Align a group: drag over the measure points to align by themselves',
      color: GROUP_COLOR,
    });
  });

  it('tells A / R / M, and nothing for a held selection key while aligning', () => {
    expect(canvasBadge(modesOf({ heldKey: 'a', lineMode: true }))?.text).toBe('Align: drag a dm line onto its right place');
    expect(canvasBadge(modesOf({ heldKey: 'r' }))?.text).toBe('Reference point: click it on the plan');
    expect(canvasBadge(modesOf({ heldKey: 'm', calibrationCount: 1 }))?.text).toBe(
      'Calibrate: click the second point of a known distance',
    );
    expect(canvasBadge(modesOf({ heldKey: 'r' }))?.color).toBe(KEY_COLORS.r);
    expect(canvasBadge(modesOf({ heldKey: 'm' }))?.color).toBe(KEY_COLORS.m);
    expect(canvasBadge(modesOf({ heldKey: 'a' }))?.color).toBe(KEY_COLORS.a);
    expect(canvasBadge(modesOf({ heldKey: 'd', aligning: true }))).toBeNull();
    expect(canvasBadge(modesOf({ heldKey: 'r', caps: noCaps }))).toBeNull();
    expect(canvasBadge(modesOf())).toBeNull();
  });

  it('tells F and Space first - they work in every mode', () => {
    expect(canvasBadge(modesOf({ heldKey: 'f', editMode: 'crop', caps: noCaps }))).toEqual({
      text: 'Fit: drag over an area to zoom to it - or let go to fit the selection',
      color: KEY_COLORS.f,
    });
    expect(canvasBadge(modesOf({ heldKey: 'space', group: { size: 2, pins: 0 } }))).toEqual({
      text: 'Pan: drag to move the plan',
      color: KEY_COLORS.space,
    });
  });
});

describe('canvasCursor', () => {
  it('is a crosshair for picking, grabbing while dragging', () => {
    expect(canvasCursor(modesOf({ tool: 'reference' }), { ...pointer, dragging: true })).toBe('crosshair');
    expect(canvasCursor(modesOf({ heldKey: 'm' }), pointer)).toBe('crosshair');
    expect(canvasCursor(modesOf(), { ...pointer, placing: true })).toBe('crosshair');
    expect(canvasCursor(modesOf(), { ...pointer, dragging: true })).toBe('grabbing');
  });

  it('grabs with Space, picks an area with F - in any mode', () => {
    expect(canvasCursor(modesOf({ heldKey: 'space', editMode: 'clear' }), pointer)).toBe('grab');
    expect(canvasCursor(modesOf({ heldKey: 'space' }), { ...pointer, dragging: true })).toBe('grabbing');
    expect(canvasCursor(modesOf({ heldKey: 'f' }), { ...pointer, hovered: hoveredItem })).toBe('crosshair');
  });

  it('grabs group points and, with A, sensors; points at sensors otherwise', () => {
    expect(canvasCursor(modesOf(), { ...pointer, hovered: hoveredItem, groupIds: new Set([1]) })).toBe('grab');
    expect(canvasCursor(modesOf({ heldKey: 'a' }), pointer)).toBe('crosshair');
    expect(canvasCursor(modesOf({ heldKey: 'a' }), { ...pointer, hovered: hoveredItem })).toBe('grab');
    expect(canvasCursor(modesOf(), { ...pointer, hovered: hoveredItem })).toBe('pointer');
    expect(canvasCursor(modesOf(), pointer)).toBe('grab');
  });
});

describe('texts', () => {
  const t = (key: string) => `t:${key}`;

  it('words the apply bar for each mode', () => {
    expect(applyBarTexts('crop', false, 0, false, t)).toEqual({
      tone: 'primary',
      message: 'Crop the plan to the selected area',
      detail: 't:image_canvas_edit_irreversible',
      label: 'Apply',
      variant: 'primary',
      color: undefined,
    });
    expect(applyBarTexts('clear', false, 0, false, t)).toMatchObject({ tone: 'danger', message: 'Fill the selected area white' });
    expect(applyBarTexts('remove', true, 2, false, t)).toMatchObject({
      tone: 'danger',
      message: 'Remove: 2 measure point(s) selected',
      detail: 't:image_canvas_remove_irreversible',
      label: 'Remove 2',
      color: undefined,
    });
    expect(applyBarTexts('cut', true, 0, true, t)).toMatchObject({
      tone: 'primary',
      detail: 'No dm sensor in the selection - drag again.',
      label: 'Cut 0',
      color: CUT_COLOR,
    });
    expect(applyBarTexts('group', true, 3, false, t)).toMatchObject({ detail: 'Esc cancels.', label: 'Align 3' });
  });

  it('tells how far a group and a point calibration are', () => {
    expect(groupHint(0, null, false)).toContain('Drag one of them onto its place');
    expect(groupHint(1, null, false)).toContain('Moved by the pin.');
    expect(groupHint(2, null, false)).toContain('Moved and scaled by the pins.');
    expect(groupHint(2, 'Too close', false)).toBe('Too close');
    expect(alignHint(1, 2, 'Too close', null, false)).toContain('Hold A and drag one more sensor');
    expect(alignHint(2, 2, 'Too close', null, false)).toBe('Too close');
    expect(alignHint(3, 2, null, 1.25, false)).toContain('off by at most 1.3 px');
  });

  it('lists what the tooltip tells about a point', () => {
    const band: MarkerItem = {
      point: { name: 'S1', device: 4, x: 0, y: 0, x_end: 30, y_end: 40, threshold: 5, last_value: 7 },
      label: '12',
      color: 'red',
      start: [0, 0],
      end: [0.1, 0],
    };
    const info = {
      deviceLabels: { 4: 'smartex dm 4' },
      devicePairStarts: { 4: 10 },
      image: { naturalWidth: 1000, naturalHeight: 500 },
      metersPerPixel: null,
      alignment: { scaleX: 1, scaleY: 1 },
      lineMode: true,
    };
    expect(tooltipRows(band, info)).toEqual([
      ['Name', 'S1'],
      ['Device', 'smartex dm 4'],
      ['Pair', '3'],
      ['Length', '5.0 CAD units'],
      ['Threshold', '5'],
      ['Last value', '7'],
    ]);
    expect(tooltipRows(band, { ...info, metersPerPixel: 0.02 })).toContainEqual(['Length', '2.0 m']);
    expect(tooltipRows({ ...band, point: { device: 9 }, end: null }, info)).toEqual([
      ['Device', '#9'],
      ['Band', 'not in the plan - shown at its label'],
    ]);
    expect(tooltipRows({ ...band, point: {}, end: null }, { ...info, lineMode: false })).toEqual([]);
  });
});

describe('canvasLegendGroups', () => {
  const titles = (groups: ReturnType<typeof canvasLegendGroups>) => groups.filter(Boolean).map((group) => group!.title);

  it('lists the groups of what is possible', () => {
    expect(titles(canvasLegendGroups(modesOf()))).toEqual([
      'View',
      'Align and scale',
      'Edit the image',
      'Measure points',
    ]);
    expect(titles(canvasLegendGroups(modesOf({ caps: noCaps }), { activeDeviceId: null }))).toEqual([
      'View',
      'Place sensors',
    ]);
  });

  it('marks what is in use', () => {
    const [view, , align, edit, points] = canvasLegendGroups(modesOf({ heldKey: 'r', editMode: 'clear' }));
    expect(view!.entries[0]).toMatchObject({ keys: ['Shift', 'Drag'] });
    expect(align!.entries.find((entry) => entry && entry.keys[0] === 'R')).toMatchObject({ active: true });
    expect(edit!.entries.find((entry) => entry && entry.keys[0] === 'C')).toMatchObject({ active: true });
    expect(edit!.entries.find((entry) => entry && entry.label === 'Select the area')).toMatchObject({ active: true });
    expect(points!.title).toBe('Measure points');
  });

  it('names the sensor to place', () => {
    const [, place] = canvasLegendGroups(modesOf({ caps: noCaps }), { activeDeviceId: 3, activeLabel: 'AA:BB' });
    expect(place!.entries[0]).toMatchObject({ label: 'Place AA:BB', active: true });
  });
});
