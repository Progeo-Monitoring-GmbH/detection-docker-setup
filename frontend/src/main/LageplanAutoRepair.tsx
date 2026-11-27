/**
 * "Auto-Repair", the optional step 6 of the Lageplan wizard for point sensors
 * (autoRepair.ts; smartex dm has the dm-Transfer there): reads the
 * plan's MPLE lines (measure_points/auto_order), shows them over the plan and
 * as a table to review - numbers for lines whose label is unreadable, a
 * direction turned - previews the new order on the canvas (onPreview) and
 * applies it (measure_points/auto_order/apply). An mx-PEEL plan's Auto-Repair
 * runs on its own after the upload: the panel follows it
 * (measure_points/auto_order/status) and opens its review when a line needs
 * a number.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Form, Spinner } from 'react-bootstrap';
import { Magic } from 'react-bootstrap-icons';
import { enqueueSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { viewBoxAttribute } from '../components/device/planViewBox';
import { usePlanViewBox, ZOOM_STEP } from '../components/device/usePlanViewBox';
import ZoomControls from '../components/device/ZoomControls';
import PillButton from '../components/ui/kit/PillButton';
import { useLatestRef } from '../components/ui/useLatestRef';
import { WheelZoomHint } from '../components/ui/wheelZoom';
import SearchableDataTable, {
  ROW_CLICK,
  selectedRowStyle,
  type SearchableColumn,
} from '../components/ui/kit/SearchableDataTable';
import { repeatedTestId } from '../testIds';
import {
  autoPlaces,
  autoRepairProblem,
  autoRepairWarnings,
  freeNumbers,
  isRunning,
  mpleLabel,
  newBadgeProblem,
  newPoints,
  nextOpenLine,
  orderedMarks,
  previewPoints,
  reviewedCables,
  type AutoOrderResult,
  type AutoRepairStatus,
  type CableEdit,
  type CableEdits,
  type ReviewedCable,
} from './autoRepair';
import { usePlanImage } from './DmTransferStep';
import { requestReason, type MeasurePoint } from './lageplanWizardUtils';
import '../components/ui/ImageCanvasStage.css';
import './LageplanAutoRepair.css';

/** How often the background Auto-Repair is asked for its state. */
export const STATUS_POLL_MS = 3000;

type Status = 'read' | 'inferred' | 'unreadable';

const statusOf = (cable: ReviewedCable): Status => {
  if (cable.inferred) {
    return 'inferred';
  }
  return cable.head_known ? 'read' : 'unreadable';
};

const STATUS_LABELS: Record<Status, string> = { read: 'Read', inferred: 'Inferred', unreadable: 'Unreadable' };

/** The review's edits for the cells (the columns stay constant). */
const EditContext = createContext<{ edit: (index: number, change: CableEdit) => void }>({
  edit: () => undefined,
});

/** The MPLE number of a line (given with the badges, AutoRepairBadges). */
const NumberCell = ({ cable }: { cable: ReviewedCable }) => (
  <span
    className={cable.number == null ? 'auto-repair-number auto-repair-number--open' : 'auto-repair-number'}
    {...repeatedTestId('auto-repair-number', cable.index)}
    {...ROW_CLICK}
  >
    {cable.number == null ? 'no number' : mpleLabel(cable.number)}
  </span>
);

/**
 * The numbers to give: click a line in the table, then its badge - the next
 * line without a number is picked at once. A number no line has can be added
 * as a badge.
 */
const AutoRepairBadges = ({
  free,
  selected,
  cables,
  onAssign,
  onClear,
  onCreate,
}: {
  free: number[];
  selected: ReviewedCable | null;
  cables: ReviewedCable[];
  onAssign: (number: number) => void;
  onClear: () => void;
  onCreate: (number: number) => void;
}) => {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = () => {
    const number = Number(draft.trim());
    const reason = draft.trim() ? newBadgeProblem(number, cables, free) : 'A number from 1 up';
    setProblem(reason);
    if (!reason) {
      onCreate(number);
      setDraft('');
    }
  };
  return (
    <div className="auto-repair-badges" data-testid="auto-repair-badges">
      <div className="auto-repair-badges-head">
        {selected ? (
          <span data-testid="auto-repair-selected">
            Line with <b>{selected.marks.length}</b> sensor(s)
            {selected.number != null ? (
              <>
                {' '}
                - now <b>{mpleLabel(selected.number)}</b>
              </>
            ) : (
              ' - no number yet'
            )}
            : click its number
          </span>
        ) : (
          <span className="auto-repair-muted">Click a line in the table, then its number.</span>
        )}
        {selected?.number != null && (
          <PillButton variant="ghost" label="Remove number" onClick={onClear} testId="auto-repair-clear" />
        )}
      </div>
      <div className="auto-repair-badge-row">
        {free.map((number) => (
          <button
            key={number}
            type="button"
            className="auto-repair-badge"
            onClick={() => onAssign(number)}
            disabled={!selected}
            title={selected ? `Give the selected line ${mpleLabel(number)}` : 'Select a line in the table first'}
            {...repeatedTestId('auto-repair-badge', number)}
          >
            {mpleLabel(number)}
          </button>
        ))}
        {!free.length && <span className="auto-repair-muted">No free number - add one:</span>}
        <span className="auto-repair-badge-new">
          <Form.Control
            size="sm"
            type="number"
            min={1}
            value={draft}
            placeholder="New number"
            aria-label="New MPLE number"
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                create();
              }
            }}
            data-testid="auto-repair-badge-input"
          />
          <PillButton variant="ghost" label="Add badge" onClick={create} testId="auto-repair-badge-add" />
        </span>
        {problem && (
          <span className="auto-repair-problem" data-testid="auto-repair-badge-problem">
            {problem}
          </span>
        )}
      </div>
    </div>
  );
};

const DirectionCell = ({ cable }: { cable: ReviewedCable }) => {
  const { edit } = useContext(EditContext);
  return (
    <span className="auto-repair-direction">
      <span className={cable.head_known && !cable.reversed ? '' : 'auto-repair-muted'}>
        {cable.head_known ? (cable.reversed ? 'turned' : 'from the label') : 'unknown'}
      </span>
      {cable.marks.length > 1 && (
        <PillButton
          variant="ghost"
          label="Turn"
          title="Number this line from its other end"
          onClick={() => edit(cable.index, { reversed: !cable.reversed })}
          testId={`auto-repair-turn-${cable.index}`}
        />
      )}
    </span>
  );
};

const COLUMNS: SearchableColumn<ReviewedCable>[] = [
  {
    id: 'mple',
    name: 'MPLE',
    // The lines still without a number first - they are the ones to give one.
    selector: (row) => row.number ?? -1,
    sortable: true,
    searchText: (row) => (row.number != null ? mpleLabel(row.number) : 'no number'),
    cell: (row) => <NumberCell cable={row} />,
    width: '120px',
  },
  {
    id: 'status',
    name: 'Label',
    selector: (row) => ['unreadable', 'inferred', 'read'].indexOf(statusOf(row)),
    sortable: true,
    searchText: (row) => STATUS_LABELS[statusOf(row)],
    cell: (row) => (
      <span className={`auto-repair-status auto-repair-status--${statusOf(row)}`} {...ROW_CLICK}>
        {STATUS_LABELS[statusOf(row)]}
        {statusOf(row) !== 'unreadable' && row.confidence ? ` ${Math.round(row.confidence * 100)} %` : ''}
      </span>
    ),
  },
  {
    id: 'sensors',
    name: 'Sensors',
    selector: (row) => row.marks.length,
    sortable: true,
    right: true,
    cell: (row) => <b {...ROW_CLICK}>{row.marks.length}</b>,
  },
  {
    id: 'direction',
    name: 'Start',
    selector: (row) => Number(row.head_known),
    sortable: true,
    cell: (row) => <DirectionCell cable={row} />,
  },
];

/** The natural size of an image (null until it loaded). */
const useImageSize = (src: string | null) => {
  const [size, setSize] = useState<{ src: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!src) {
      return undefined;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled && image.naturalWidth > 0) {
        setSize({ src, width: image.naturalWidth, height: image.naturalHeight });
      }
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return size && size.src === src ? size : null;
};

/** The lines over the plan: read ones green, inferred amber, unreadable red,
 * the start as dot with the number - the hovered line stands out. Zoomed and
 * moved like the other plans (usePlanViewBox: Ctrl + wheel, drag, two fingers). */
const CableOverview = ({
  imageUrl,
  cables,
  highlighted,
  selected,
}: {
  imageUrl: string | null | undefined;
  cables: ReviewedCable[];
  highlighted: number | null;
  /** The line the next badge numbers. */
  selected: number | null;
}) => {
  const src = usePlanImage(imageUrl);
  const size = useImageSize(src);
  const svgRef = useRef<SVGSVGElement>(null);
  // The SVG exists once the image loaded - its listeners follow then.
  const view = usePlanViewBox(svgRef, size?.width ?? 1, size?.height ?? 1, Boolean(src && size));
  if (!src || !size) {
    return (
      <div className="auto-repair-overview auto-repair-overview--loading">
        <Spinner animation="border" size="sm" />
      </div>
    );
  }
  // Dots and numbers keep their size on screen at every zoom.
  const unit = view.box.w / 1000;
  return (
    <div
      className="auto-repair-overview"
      // The plan's own proportions (only known once it loaded).
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
      data-testid="auto-repair-overview"
    >
      <svg
        ref={svgRef}
        viewBox={viewBoxAttribute(view.box)}
        preserveAspectRatio="xMidYMid meet"
        className={[
          'auto-repair-overview-svg',
          view.dragging ? 'auto-repair-overview-svg--grabbing' : view.zoomed ? 'auto-repair-overview-svg--grab' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ touchAction: view.touchAction }}
        role="img"
        aria-label="Lageplan with the MPLE lines"
        data-testid="auto-repair-overview-plan"
        {...view.handlers}
      >
        <image href={src} x={0} y={0} width={size.width} height={size.height} preserveAspectRatio="none" />
        {cables.map((cable) => {
          const [[x1, y1], [x2, y2]] = cable.line;
          const status = cable.number == null ? 'unreadable' : cable.numberEdited ? 'read' : statusOf(cable);
          const [hx, hy] = [x1 * size.width, y1 * size.height];
          return (
            <g
              key={cable.index}
              className={[
                'auto-repair-line',
                `auto-repair-line--${status}`,
                highlighted === cable.index ? 'auto-repair-line--highlighted' : '',
                selected === cable.index ? 'auto-repair-line--selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <line x1={hx} y1={hy} x2={x2 * size.width} y2={y2 * size.height} vectorEffect="non-scaling-stroke" />
              <circle cx={hx} cy={hy} r={5 * unit} />
              <text x={hx + 7 * unit} y={hy - 7 * unit} fontSize={15 * unit} strokeWidth={3 * unit}>
                {cable.number ?? '?'}
              </text>
            </g>
          );
        })}
      </svg>
      <WheelZoomHint visible={view.wheelHint} radius={10} testId="auto-repair-overview-wheel-hint" />
      <ZoomControls
        onZoomIn={() => view.zoomBy(ZOOM_STEP)}
        onZoomOut={() => view.zoomBy(1 / ZOOM_STEP)}
        onReset={view.reset}
        zoomOutDisabled={!view.zoomed}
        resetDisabled={!view.zoomed}
        testId="auto-repair-overview-zoom"
      />
    </div>
  );
};

type LageplanAutoRepairProps = {
  /** The location's project id (the measure_points endpoints' location_id). */
  locationId: number | null;
  planId: number | null;
  planUrl: string | null | undefined;
  planPoints: MeasurePoint[];
  /** The location's highest sensor number - new points are numbered after it. */
  highestOrder: number;
  canEdit: boolean;
  /** The points as the canvas shows them while the new order is reviewed - null: as stored. */
  onPreview: (points: MeasurePoint[] | null) => void;
  onStored: () => void;
};

const LageplanAutoRepair = ({
  locationId,
  planId,
  planUrl,
  planPoints,
  highestOrder,
  canEdit,
  onPreview,
  onStored,
}: LageplanAutoRepairProps) => {
  const auth = useAuth();
  const [result, setResult] = useState<AutoOrderResult | null>(null);
  const [edits, setEdits] = useState<CableEdits>({});
  const [busy, setBusy] = useState<'reading' | 'storing' | null>(null);
  const [error, setError] = useState('');
  const [highlighted, setHighlighted] = useState<number | null>(null);
  // The line the next badge numbers, and the badges added by hand.
  const [selected, setSelected] = useState<number | null>(null);
  const [createdBadges, setCreatedBadges] = useState<number[]>([]);
  const [background, setBackground] = useState<AutoRepairStatus | null>(null);

  // Another plan: the answer was for the old one.
  const shown = result && result.lageplan_id === planId ? result : null;
  const cables = useMemo(() => (shown ? reviewedCables(shown, edits) : []), [shown, edits]);
  const free = useMemo(() => (shown ? freeNumbers(shown, cables, createdBadges) : []), [shown, cables, createdBadges]);
  const selectedCable = cables.find((cable) => cable.index === selected) ?? null;
  const selectedKeys = useMemo(() => new Set(selected == null ? [] : [selected]), [selected]);
  const rowStyles = useMemo(
    () => [selectedRowStyle<ReviewedCable, number>({ rowKey: (row) => row.index, selected: selectedKeys })],
    [selectedKeys],
  );

  /** A new analysis to review: its first line without a number is picked. */
  const startReview = (answer: AutoOrderResult) => {
    setResult(answer);
    setEdits({});
    setCreatedBadges([]);
    setSelected(nextOpenLine(reviewedCables(answer, {}), null));
  };

  /** The badge's number for the selected line - then on to the next line without one. */
  const assign = (number: number) => {
    if (!shown || selected == null) {
      return;
    }
    const next = { ...edits, [selected]: { ...edits[selected], number } };
    setEdits(next);
    setSelected(nextOpenLine(reviewedCables(shown, next), selected));
  };
  const marks = useMemo(() => orderedMarks(cables), [cables]);
  const places = useMemo(() => autoPlaces(planPoints, marks), [planPoints, marks]);
  const created = useMemo(() => newPoints(planPoints.length, marks, highestOrder), [planPoints, marks, highestOrder]);
  const preview = useMemo(
    () => (shown ? previewPoints(planPoints, places, created) : null),
    [shown, planPoints, places, created],
  );
  const problem = shown ? autoRepairProblem(cables) : null;
  const warnings = shown ? autoRepairWarnings(shown, cables, planPoints.length) : [];

  useEffect(() => {
    onPreview(preview);
  }, [preview, onPreview]);
  // Leaving the step's plan (or the wizard): the canvas shows the stored points again.
  useEffect(() => () => onPreview(null), [onPreview]);

  // The Auto-Repair an mx-PEEL upload started in the background: followed
  // until it is done - placed (the points reload) or left for the review.
  const onStoredRef = useLatestRef(onStored);
  const startReviewRef = useLatestRef(startReview);
  useEffect(() => {
    if (locationId === null || planId === null) {
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wasRunning = false;
    const ask = () => {
      void axiosConfig.perform_get(
        auth,
        `/v1/status/measure_points/auto_order/status/?location_id=${locationId}&lageplan_id=${planId}`,
        (response) => {
          if (cancelled) {
            return;
          }
          const status = (response?.data ?? null) as AutoRepairStatus | null;
          setBackground(status);
          if (isRunning(status)) {
            wasRunning = true;
            timer = setTimeout(ask, STATUS_POLL_MS);
            return;
          }
          if (status?.state === 'review' && status.result) {
            startReviewRef.current(status.result);
          }
          if (status?.state === 'applied' && wasRunning) {
            const placed = status.placed;
            enqueueSnackbar(
              `Auto-Repair: ${placed ? placed.moved + placed.created : 0} measure point(s) placed on the plan's marks.`,
              { variant: 'success' },
            );
            onStoredRef.current();
          }
        },
        () => undefined,
      );
    };
    ask();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
    // The plan's own run - asked once per plan (and while it runs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, planId]);

  const context = useMemo(
    () => ({
      edit: (index: number, change: CableEdit) =>
        setEdits((current) => ({ ...current, [index]: { ...current[index], ...change } })),
    }),
    [],
  );

  const read = () => {
    if (locationId === null || planId === null) {
      return;
    }
    setBusy('reading');
    setError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/auto_order/',
      { location_id: locationId, lageplan_id: planId },
      (response) => {
        startReview(response?.data as AutoOrderResult);
        setBusy(null);
      },
      (requestError) => {
        setError(`Could not read the plan: ${requestReason(requestError)}`);
        setBusy(null);
      },
    );
  };

  const discard = () => {
    setResult(null);
    setEdits({});
    setSelected(null);
    setCreatedBadges([]);
    setError('');
  };

  const apply = () => {
    if (locationId === null || planId === null || problem || !marks.length) {
      return;
    }
    setBusy('storing');
    setError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/auto_order/apply/',
      { location_id: locationId, lageplan_id: planId, marks },
      (response) => {
        const moved = Number(response?.data?.moved ?? places.length);
        const made = Number(response?.data?.created ?? created.length);
        enqueueSnackbar(
          `${moved + made} measure point(s) placed in the MPLE order${made ? ` (${made} new)` : ''}.`,
          { variant: 'success' },
        );
        setBusy(null);
        setBackground(null);
        discard();
        onStored();
      },
      (requestError) => {
        setError(`Could not store the order: ${requestReason(requestError)}`);
        setBusy(null);
      },
    );
  };

  const running = isRunning(background);
  return (
    <div className="auto-repair" data-testid="auto-repair">
      {running && (
        <div className="lageplan-notice auto-repair-background" data-testid="auto-repair-running">
          <Spinner size="sm" animation="border" /> Auto-Repair is reading the uploaded plan in the background - its
          sensor marks become the measure points (up to half a minute).
        </div>
      )}
      {!running && background?.state === 'failed' && !shown && (
        <div className="lageplan-notice lageplan-notice--warning" data-testid="auto-repair-failed">
          The automatic Auto-Repair of this plan failed{background.message ? `: ${background.message}` : ''}.
        </div>
      )}
      {!running && background?.state === 'review' && shown && (
        <div className="lageplan-notice lageplan-notice--warning" data-testid="auto-repair-review">
          The automatic Auto-Repair needs you: {background.message}
        </div>
      )}

      {!shown && !running && (
        <div className="auto-repair-actions">
          {/* The wizard style of the auto functions (Auto-align, ImageCanvasStage.css). */}
          <button
            type="button"
            className="image-canvas-pill image-canvas-auto btn btn-sm"
            onClick={read}
            disabled={busy !== null || !canEdit || locationId === null || planId === null}
            title="Read the MPLE lines of the plan and number the sensors along them"
            data-testid="auto-repair-start"
          >
            {busy === 'reading' ? (
              <span className="spinner-border spinner-border-sm me-1" aria-hidden />
            ) : (
              <Magic className="me-1" aria-hidden />
            )}
            {busy === 'reading' ? 'Reading the plan…' : 'Auto-Repair'}
          </button>
          <span className="auto-repair-muted">
            {busy === 'reading'
              ? 'Reading lines, labels and sensor marks - this takes up to half a minute…'
              : 'Reads the MPLE lines (orange, “MPLE n” at their start) and their sensor marks: the marks become the measure points, numbered line by line - MPLE 1 from its start, then MPLE 2, …'}
          </span>
        </div>
      )}

      {error && (
        <div className="lageplan-notice lageplan-notice--danger" role="alert" data-testid="auto-repair-error">
          {error}
        </div>
      )}

      {shown && (
        <EditContext.Provider value={context}>
          <div className="auto-repair-summary" data-testid="auto-repair-summary">
            <span>
              <b>{shown.cables.length}</b> MPLE lines
            </span>
            <span>
              <b>{shown.labels}</b> labels read
            </span>
            {shown.inferred > 0 && (
              <span>
                <b>{shown.inferred}</b> inferred
              </span>
            )}
            {shown.unlabelled > 0 && (
              <span className="auto-repair-summary--warn">
                <b>{shown.unlabelled}</b> unreadable
              </span>
            )}
            <span>
              <b>{shown.marks}</b> sensor marks
            </span>
            <span>
              <b>{planPoints.length}</b> measure points
            </span>
          </div>
          {!shown.ocr && (
            <div className="lageplan-notice lageplan-notice--warning" data-testid="auto-repair-no-ocr">
              Text recognition is not available on the server - give the lines their numbers with the badges
              (add a badge for each number).
            </div>
          )}
          <AutoRepairBadges
            free={free}
            selected={selectedCable}
            cables={cables}
            onAssign={assign}
            onClear={() => selected != null && context.edit(selected, { number: null })}
            onCreate={(number) => setCreatedBadges((current) => [...current, number])}
          />
          <div className="auto-repair-body">
            <CableOverview imageUrl={planUrl} cables={cables} highlighted={highlighted} selected={selected} />
            <div className="auto-repair-table" onMouseLeave={() => setHighlighted(null)}>
              <SearchableDataTable<ReviewedCable, number>
                columns={COLUMNS}
                data={cables}
                dense
                keyField="index"
                testId="auto-repair-table"
                defaultSortFieldId="mple"
                pointerOnHover
                onRowClicked={(row) => setSelected(row.index)}
                conditionalRowStyles={rowStyles}
                onRowMouseEnter={(row) => setHighlighted(row.index)}
                pagination={cables.length > 20}
                paginationPerPage={20}
                mobileColumns={['mple', 'sensors']}
              />
            </div>
          </div>
          {warnings.length > 0 && (
            <ul className="auto-repair-warnings" data-testid="auto-repair-warnings">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="auto-repair-actions">
            <PillButton
              variant="accent"
              label={
                busy === 'storing'
                  ? 'Storing…'
                  : `Apply order (${places.length + created.length} points${created.length ? `, ${created.length} new` : ''})`
              }
              onClick={apply}
              disabled={busy !== null || problem !== null || !marks.length || !canEdit}
              testId="auto-repair-apply"
            />
            <PillButton variant="ghost" label="Discard" onClick={discard} disabled={busy !== null} testId="auto-repair-discard" />
            <span className={problem ? 'auto-repair-problem' : 'auto-repair-muted'} data-testid="auto-repair-problem">
              {problem ?? 'The canvas shows the new order - the numbers stay, the points move onto the marks.'}
            </span>
          </div>
        </EditContext.Provider>
      )}
    </div>
  );
};

export default LageplanAutoRepair;
