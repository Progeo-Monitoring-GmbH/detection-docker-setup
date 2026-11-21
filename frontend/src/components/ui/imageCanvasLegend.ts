/**
 * The key legend over the plan canvas (ImageCanvasStage): which keys and
 * mouse actions there are with the props given, the one in use highlighted.
 */
import type { LegendGroup } from './CanvasKeyLegend';
import {
  editingOf,
  pointNounOf,
  pointSelectOf,
  type CanvasModes,
  type HeldKey,
  type SelectMode,
} from './imageCanvasModes';

type Placement = { activeDeviceId: number | null; activeLabel?: string };

const viewGroup = (modes: CanvasModes, placement: Placement | undefined): LegendGroup => ({
  title: 'View',
  entries: [
    { keys: editingOf(modes) ? ['Shift', 'Drag'] : ['Drag'], label: 'Move the plan' },
    { keys: ['Ctrl', 'Scroll'], label: 'Zoom - or the buttons on the plan' },
    !placement && { keys: ['Hover'], label: 'Details of a sensor' },
  ],
});

const placeGroup = (modes: CanvasModes, placement: Placement): LegendGroup => ({
  title: 'Place sensors',
  entries: [
    {
      keys: ['Click'],
      label:
        placement.activeDeviceId != null
          ? `Place ${placement.activeLabel ?? 'the selected sensor'}`
          : 'Place the sensor selected in step 3',
      active: placement.activeDeviceId != null && !editingOf(modes),
    },
    { keys: ['Drag'], label: 'Move a placed sensor (drag the dot)' },
  ],
});

const alignGroup = ({ caps, heldKey, tool, aligning, lineMode }: CanvasModes): LegendGroup | null =>
  caps.canAlign || caps.canScale
    ? {
        title: 'Align and scale',
        entries: [
          caps.canAlign && {
            keys: ['A', 'Drag'],
            label: `Hold A, drag a ${lineMode ? 'dm line' : 'sensor'} onto its place`,
            active: heldKey === 'a' || aligning,
          },
          caps.canScale && {
            keys: ['R', 'Click'],
            label: 'Hold R, click the reference point',
            active: heldKey === 'r' || tool === 'reference',
          },
          caps.canScale && {
            keys: ['M', 'Click'],
            label: 'Hold M, click two points of a known distance',
            active: heldKey === 'm',
          },
        ],
      }
    : null;

const imageGroup = (modes: CanvasModes): LegendGroup | null => {
  if (!modes.caps.canEditImage) {
    return null;
  }
  const selectingArea = editingOf(modes) && pointSelectOf(modes.editMode) == null;
  return {
    title: 'Edit the image',
    entries: [
      { keys: ['C'], label: 'Clear an area - fill it white', active: modes.editMode === 'clear' },
      { keys: ['X'], label: 'Crop the plan to an area', active: modes.editMode === 'crop' },
      { keys: ['↺ / ↻'], label: 'Rotate the plan by 90° (buttons on the plan) - the sensors turn with it' },
      selectingArea && {
        keys: ['Drag'],
        label: modes.hasSelection ? 'Select the area again' : 'Select the area',
        active: !modes.hasSelection,
      },
      { keys: ['Esc'], label: 'Cancel' },
    ],
    note: 'Nothing changes before "Apply" - the sensors keep their place.',
  };
};

/** The measure point keys, in the legend's order: the capability each needs,
 * its key, what it does, and the edit mode it is in use with. */
const POINT_KEYS: Array<{
  cap: keyof CanvasModes['caps'];
  key: HeldKey;
  mouse: string;
  label: (noun: string, modes: CanvasModes) => string;
  mode?: SelectMode;
}> = [
  { cap: 'canRemovePoints', key: 'd', mouse: 'Drag', label: (noun) => `Hold D, drag over ${noun}s to remove them`, mode: 'remove' },
  { cap: 'canCut', key: 'o', mouse: 'Drag', label: (noun) => `Hold O, drag over ${noun}s to cut them out`, mode: 'cut' },
  {
    cap: 'canInsert',
    key: 'i',
    mouse: 'Click',
    label: (_noun, modes) => `Hold I, click where the ${modes.cutCount} cut one(s) go - on any plan`,
  },
  {
    cap: 'canGroup',
    key: 'l',
    mouse: 'Drag',
    label: (noun) => `Hold L, drag over ${noun}s to align them by themselves`,
    mode: 'group',
  },
];

const pointsGroup = (modes: CanvasModes): LegendGroup | null => {
  const offered = POINT_KEYS.filter((entry) => modes.caps[entry.cap]);
  if (!offered.length) {
    return null;
  }
  const noun = pointNounOf(modes.lineMode);
  return {
    title: modes.lineMode ? 'dm sensors' : 'Measure points',
    entries: [
      ...offered.map((entry) => ({
        keys: [entry.key.toUpperCase(), entry.mouse],
        label: entry.label(noun, modes),
        // A group alignment going on is L's, too.
        active:
          modes.heldKey === entry.key ||
          (entry.mode != null && modes.editMode === entry.mode) ||
          (entry.key === 'l' && modes.group != null),
      })),
      { keys: ['Esc'], label: 'Cancel' },
    ],
    note: `Removing is for good once "Remove" is pressed; cut ${noun}s stay where they were until inserted. All keep their number.`,
  };
};

/** The legend's groups: view, placing sensors, align and scale, image edits, measure points. */
export const canvasLegendGroups = (modes: CanvasModes, placement?: Placement): Array<LegendGroup | null> => [
  viewGroup(modes, placement),
  placement ? placeGroup(modes, placement) : null,
  alignGroup(modes),
  imageGroup(modes),
  pointsGroup(modes),
];
