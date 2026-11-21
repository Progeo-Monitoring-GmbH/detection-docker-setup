import {
  useEffect,
  useId,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ACTION_COLORS,
  MIN_DRAG,
  NOTE_ACTIONS,
  areaBetween,
  imagePointOf,
  isArea,
  isArrow,
  sliceHeightOf,
  slicesOf,
  type DraftShape,
  type NoteAction,
  type ScreenImage,
  type ScreenNote,
  type Slice,
} from './screenReview';
import './StitchedScreenshot.css';

type Point = { x: number; y: number };

type StitchedScreenshotProps = {
  /** The image (an object URL); null while it loads. */
  src: string | null;
  image: ScreenImage;
  /** Screen height of a full part (px) - the parts scale to it. */
  partHeight: number;
  notes?: ScreenNote[];
  selectedNoteId?: number | null;
  onSelectNote?: (id: number) => void;
  /** The shape drawn with the pointer; null: no drawing. */
  tool?: 'arrow' | 'area' | null;
  /** The part the gallery's keyboard / swipe cursor is on - framed. */
  activePart?: number | null;
  /** The shape being drawn / not saved yet - shown like a note. */
  draft?: DraftShape | null;
  /** The shape while it is drawn (done: false) and when let go (done: true; null: too short). */
  onDraft?: (shape: DraftShape | null, done: boolean) => void;
  testId?: string;
};

const shapeOf = (
  tool: 'arrow' | 'area',
  start: Point,
  end: Point,
): DraftShape =>
  tool === 'arrow'
    ? {
        kind: 'arrow',
        geometry: { x1: start.x, y1: start.y, x2: end.x, y2: end.y },
      }
    : { kind: 'area', geometry: areaBetween(start, end) };

/**
 * A long screenshot cut into parts of a window's height, side by side -
 * each framed and numbered, so the page reads left to right without
 * scrolling down. Every part is a window onto the same image; the notes
 * (arrows, areas) are drawn in image pixels over each part, so a note
 * crossing two parts shows on both. With a `tool` the pointer draws a new
 * shape (it may run over several parts).
 */
const StitchedScreenshot = ({
  src,
  image,
  partHeight,
  notes = [],
  selectedNoteId = null,
  onSelectNote,
  tool = null,
  draft = null,
  activePart = null,
  onDraft,
  testId = 'stitched-screenshot',
}: StitchedScreenshotProps) => {
  const { t } = useTranslation();
  const markerId = useId().replace(/:/g, '');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ start: Point; end: Point } | null>(null);
  const sliceHeight = sliceHeightOf(image);
  const slices = slicesOf(image.height, sliceHeight);
  const scale = partHeight / sliceHeight;
  const partWidth = image.width * scale;

  // The point of the image under the pointer - on whichever part it is.
  const pointAt = (clientX: number, clientY: number): Point | null => {
    const element = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-slice-index]');
    if (!element || !rootRef.current?.contains(element)) {
      return null;
    }
    const slice = slices[Number(element.dataset.sliceIndex)];
    return slice
      ? imagePointOf(
          slice,
          element.getBoundingClientRect(),
          image.width,
          clientX,
          clientY,
        )
      : null;
  };

  const startDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    slice: Slice,
  ) => {
    if (!tool || !onDraft || event.button !== 0) {
      return;
    }
    event.preventDefault();
    const start = imagePointOf(
      slice,
      event.currentTarget.getBoundingClientRect(),
      image.width,
      event.clientX,
      event.clientY,
    );
    dragRef.current = { start, end: start };
    onDraft(shapeOf(tool, start, start), false);
  };

  // While drawing: the pointer anywhere (also over other parts) and its release.
  const onDraftRef = useRef(onDraft);
  useEffect(() => {
    onDraftRef.current = onDraft;
  });
  useEffect(() => {
    if (!tool) {
      return undefined;
    }
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      const point = drag ? pointAt(event.clientX, event.clientY) : null;
      if (drag && point) {
        drag.end = point;
        onDraftRef.current?.(shapeOf(tool, drag.start, point), false);
      }
    };
    const up = () => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      dragRef.current = null;
      const length = Math.hypot(
        drag.end.x - drag.start.x,
        drag.end.y - drag.start.y,
      );
      onDraftRef.current?.(
        length * scale < MIN_DRAG ? null : shapeOf(tool, drag.start, drag.end),
        true,
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // pointAt reads the current slices through its closure - renewed with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, scale, image.width, image.height, sliceHeight]);

  // Screen sizes in image pixels (the overlay is in image pixels).
  const badge = 11 / scale;
  const shapes = [
    ...notes.map((note, index) => ({
      key: `note-${note.id}`,
      number: index + 1,
      note,
      draft: false,
    })),
    ...(draft && draft.kind !== 'note'
      ? [
          {
            key: 'draft',
            number: notes.length + 1,
            note: { ...draft, action: 'select' as NoteAction, id: -1 },
            draft: true,
          },
        ]
      : []),
  ];

  const renderShape = ({
    key,
    number,
    note,
    draft: isDraft,
  }: (typeof shapes)[number]) => {
    const color = isDraft ? '#094b81' : ACTION_COLORS[note.action];
    const selected = !isDraft && note.id === selectedNoteId;
    const isDone = !isDraft && 'done' in note && Boolean(note.done);
    const select =
      !isDraft && onSelectNote && !tool
        ? () => onSelectNote(note.id)
        : undefined;
    const className = `stitched-shape${selected ? ' stitched-shape--selected' : ''}${isDraft ? ' stitched-shape--draft' : ''}${isDone ? ' stitched-shape--done' : ''}${select ? ' stitched-shape--clickable' : ''}`;
    if (isArea(note.geometry)) {
      const { x, y, w, h } = note.geometry;
      return (
        <g key={key} className={className} onClick={select}>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill={color}
            fillOpacity={0.12}
            stroke={color}
          />
          <circle cx={x} cy={y} r={badge} fill={color} />
          <text x={x} y={y} fontSize={badge * 1.2}>
            {number}
          </text>
        </g>
      );
    }
    if (isArrow(note.geometry)) {
      const { x1, y1, x2, y2 } = note.geometry;
      return (
        <g key={key} className={className} onClick={select}>
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={color}
            markerEnd={`url(#${markerId}-${isDraft ? 'draft' : note.action})`}
          />
          <circle cx={x1} cy={y1} r={badge} fill={color} />
          <text x={x1} y={y1} fontSize={badge * 1.2}>
            {number}
          </text>
        </g>
      );
    }
    return null;
  };

  return (
    <div
      ref={rootRef}
      className={`stitched${tool ? ' stitched--drawing' : ''}`}
      data-testid={testId}
    >
      {slices.map((slice) => (
        <div
          key={slice.index}
          className={`stitched-part${slice.index === activePart ? ' stitched-part--active' : ''}`}
          data-part-index={slice.index}
        >
          <div
            className="stitched-slice"
            data-slice-index={slice.index}
            style={{
              width: `${partWidth}px`,
              height: `${slice.height * scale}px`,
              backgroundImage: src ? `url(${src})` : undefined,
              backgroundSize: `${partWidth}px ${image.height * scale}px`,
              backgroundPosition: `0 ${-slice.top * scale}px`,
            }}
            onPointerDown={(event) => startDrag(event, slice)}
          >
            <svg
              className="stitched-overlay"
              viewBox={`0 ${slice.top} ${image.width} ${slice.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                {[...NOTE_ACTIONS, 'draft'].map((action) => (
                  <marker
                    key={action}
                    id={`${markerId}-${action}`}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    // In image pixels, ~14 px on screen whatever the zoom.
                    markerUnits="userSpaceOnUse"
                    markerWidth={14 / scale}
                    markerHeight={14 / scale}
                    orient="auto-start-reverse"
                  >
                    <path
                      d="M0,0 L10,5 L0,10 z"
                      fill={
                        action === 'draft'
                          ? '#094b81'
                          : ACTION_COLORS[action as NoteAction]
                      }
                    />
                  </marker>
                ))}
              </defs>
              {shapes.map(renderShape)}
            </svg>
          </div>
          <span
            className="stitched-part-number"
            title={t('screens_part', { number: slice.index + 1 })}
          >
            {slice.index + 1}
          </span>
        </div>
      ))}
    </div>
  );
};

export default StitchedScreenshot;
