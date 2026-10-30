import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { ArrowCounterclockwise, Check2, PencilSquare, PlusLg, Trash, XLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { plotTheme } from '../../styles/plotTheme';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import { toScreen, toWorld, type View, type WorldSize } from './heatmapCanvas';
import { centroid, MIN_AREA_POINTS, nearestEdge, toPlanPoint, toWorldPoint, type Point } from './heatLimitations';
import type { HeatLimitation, SensorHeatmapLageplanData } from './sensorHeatmapTypes';

/** The area being drawn: a new one (id null) or a copy of an existing one. */
export type HeatLimitationDraft = { id: string | null; name: string; points: Point[] };

const DRAFT_COLOR = plotTheme.brandOrange;
const AREA_COLOR = plotTheme.brandBlue;
const HANDLE_RADIUS = 7;

/**
 * Heat limitations of the shown Lageplan (ProgeoLageplan.heat_limitations)
 * and their editing - superusers draw an area as draggable points on the
 * heatmap and confirm it (POST /v1/location/<id>/heat-limitations/), edit or
 * delete existing ones. The saved list is kept per plan until the plans
 * change (a new response brings it along).
 */
export const useHeatLimitationEditor = ({
  plans,
  plan,
  editable,
}: {
  plans: SensorHeatmapLageplanData[] | null;
  plan: SensorHeatmapLageplanData | null;
  /** Whether the user may edit (superuser, plan image shown). */
  editable: boolean;
}) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [saved, setSaved] = useState<{ plans: typeof plans; byPlan: Record<number, HeatLimitation[]> } | null>(null);
  const [drawn, setDrawn] = useState<{ planId: number | null; draft: HeatLimitationDraft } | null>(null);
  const [busy, setBusy] = useState(false);

  const planId = plan?.id ?? null;
  const locationId = plan?.location_id ?? null;
  const savedAreas = planId != null && saved?.plans === plans ? saved.byPlan[planId] : undefined;
  const areas = useMemo(() => savedAreas ?? plan?.heat_limitations ?? [], [savedAreas, plan]);
  const canEdit = editable && planId != null && locationId != null;
  // Another plan (or no editing): whatever was drawn belonged to the previous one.
  const draft = canEdit && drawn?.planId === planId ? drawn.draft : null;
  const setDraft = (
    change: HeatLimitationDraft | null | ((current: HeatLimitationDraft | null) => HeatLimitationDraft | null),
  ) =>
    setDrawn((current) => {
      const next = typeof change === 'function' ? change(current?.planId === planId ? current.draft : null) : change;
      return next ? { planId, draft: next } : null;
    });

  /** The areas as the heat field is clipped right now: the draft (once it is
   * an area) in place of the one it edits. */
  const shownAreas = useMemo(() => {
    if (!draft || draft.points.length < MIN_AREA_POINTS) {
      return areas;
    }
    const preview = { id: draft.id ?? '__draft__', name: draft.name, points: draft.points };
    return draft.id ? areas.map((area) => (area.id === draft.id ? preview : area)) : [...areas, preview];
  }, [areas, draft]);

  const post = (suffix: string, data: Record<string, unknown>, success: string) => {
    if (planId == null || locationId == null) {
      return;
    }
    setBusy(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/heat-limitations/${suffix}`,
      { lageplan_id: planId, ...data },
      (response) => {
        const list = (response?.data?.heat_limitations ?? []) as HeatLimitation[];
        setSaved((current) => ({
          plans,
          byPlan: { ...(current?.plans === plans ? current.byPlan : {}), [planId]: list },
        }));
        setDraft(null);
        setBusy(false);
        showSuccessBar(enqueueSnackbar, success);
      },
      (error) => {
        setBusy(false);
        showRequestError(enqueueSnackbar, t('heat_limit_save_failed'), error);
      },
    );
  };

  const updatePoints = (change: (points: Point[]) => Point[]) =>
    setDraft((current) => (current ? { ...current, points: change(current.points) } : current));

  return {
    areas,
    shownAreas,
    draft,
    busy,
    canEdit,
    start: () => setDraft({ id: null, name: '', points: [] }),
    edit: (area: HeatLimitation) => setDraft({ id: area.id, name: area.name ?? '', points: [...area.points] }),
    cancel: () => setDraft(null),
    setName: (name: string) => setDraft((current) => (current ? { ...current, name } : current)),
    /** A click on the plan: a new area grows at its end, an existing one gets
     * the point in its nearest edge. */
    addPoint: (point: Point, world: WorldSize) =>
      updatePoints((points) => {
        if (!draft?.id || points.length < MIN_AREA_POINTS) {
          return [...points, point];
        }
        const worldPoints = points.map((p) => toWorldPoint(p, world));
        const { index } = nearestEdge(worldPoints, toWorldPoint(point, world));
        return [...points.slice(0, index + 1), point, ...points.slice(index + 1)];
      }),
    movePoint: (index: number, point: Point) =>
      updatePoints((points) => points.map((p, i) => (i === index ? point : p))),
    removePoint: (index: number) => updatePoints((points) => points.filter((_, i) => i !== index)),
    undoPoint: () => updatePoints((points) => points.slice(0, -1)),
    confirm: () => {
      if (draft && draft.points.length >= MIN_AREA_POINTS) {
        post('', { id: draft.id ?? undefined, name: draft.name, points: draft.points }, t('heat_limit_saved'));
      }
    },
    remove: (area: HeatLimitation) => {
      if (window.confirm(t('heat_limit_delete_confirm', { name: area.name || t('heat_limit_unnamed') }))) {
        post('delete/', { id: area.id }, t('heat_limit_deleted'));
      }
    },
  };
};

export type HeatLimitationEditor = ReturnType<typeof useHeatLimitationEditor>;

/**
 * The controls above the heatmap (superusers only): "Create Heat-Limitation"
 * and the existing areas with edit / delete - while drawing, the name, the
 * hint and Confirm / Cancel.
 */
export const HeatLimitationBar = ({ editor }: { editor: HeatLimitationEditor }) => {
  const { t } = useTranslation();
  if (!editor.canEdit) {
    return null;
  }
  const { draft, busy } = editor;

  if (draft) {
    const enough = draft.points.length >= MIN_AREA_POINTS;
    return (
      <div className="d-flex flex-wrap align-items-center gap-2 mt-2" data-testid="heat-limit-draft">
        <Form.Control
          size="sm"
          style={{ maxWidth: 220 }}
          placeholder={t('heat_limit_name')}
          aria-label={t('heat_limit_name')}
          value={draft.name}
          maxLength={100}
          onChange={(event) => editor.setName(event.target.value)}
        />
        <span className="small text-muted">
          {t(draft.id ? 'heat_limit_hint_edit' : 'heat_limit_hint_create', { count: draft.points.length })}
        </span>
        {!draft.id && (
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={editor.undoPoint}
            disabled={busy || draft.points.length === 0}
          >
            <ArrowCounterclockwise className="me-1" />
            {t('heat_limit_undo')}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={editor.confirm} disabled={busy || !enough}>
          {busy ? <Spinner size="sm" animation="border" className="me-1" /> : <Check2 className="me-1" />}
          {t('heat_limit_confirm')}
        </Button>
        <Button size="sm" variant="outline-secondary" onClick={editor.cancel} disabled={busy}>
          <XLg className="me-1" />
          {t('heat_limit_cancel')}
        </Button>
      </div>
    );
  }

  return (
    <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
      <Button size="sm" variant="outline-primary" onClick={editor.start} disabled={busy}>
        <PlusLg className="me-1" />
        {t('heat_limit_create')}
      </Button>
      {editor.areas.map((area, index) => (
        <span
          key={area.id}
          className="d-inline-flex align-items-center gap-1 small border rounded-pill ps-2 pe-1"
          style={{ color: AREA_COLOR }}
        >
          {area.name || t('heat_limit_numbered', { number: index + 1 })}
          <Button
            size="sm"
            variant="link"
            className="p-0 px-1"
            title={t('heat_limit_edit')}
            aria-label={t('heat_limit_edit')}
            onClick={() => editor.edit(area)}
            disabled={busy}
          >
            <PencilSquare />
          </Button>
          <Button
            size="sm"
            variant="link"
            className="p-0 px-1 text-danger"
            title={t('heat_limit_delete')}
            aria-label={t('heat_limit_delete')}
            onClick={() => editor.remove(area)}
            disabled={busy}
          >
            <Trash />
          </Button>
        </span>
      ))}
    </div>
  );
};

/**
 * The areas over the heatmap canvas (superusers only), in its view: saved
 * ones outlined with their name, the draft filled with draggable points
 * (double-click removes one). Only the points take the pointer - the canvas
 * below keeps zooming, moving and, while drawing, receives the clicks that
 * add points.
 */
export const HeatLimitationLayer = ({
  editor,
  view,
  world,
  width,
  height,
}: {
  editor: HeatLimitationEditor;
  view: View;
  world: WorldSize;
  width: number;
  height: number;
}) => {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<number | null>(null);
  if (!editor.canEdit) {
    return null;
  }
  const { draft } = editor;
  const screen = (point: Point) => toScreen(view, ...toWorldPoint(point, world));
  const path = (points: Point[]) => points.map((point) => screen(point).join(',')).join(' ');

  const planPointAt = (event: PointerEvent): Point | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    return toPlanPoint(toWorld(view, event.clientX - rect.left, event.clientY - rect.top), world);
  };

  const onHandleDown = (index: number) => (event: PointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragging.current = index;
  };
  const onHandleMove = (event: PointerEvent<SVGCircleElement>) => {
    if (dragging.current == null) {
      return;
    }
    const point = planPointAt(event);
    if (point) {
      editor.movePoint(dragging.current, point);
    }
  };
  const onHandleUp = (event: PointerEvent<SVGCircleElement>) => {
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
      aria-hidden={draft ? undefined : true}
    >
      {editor.areas
        .filter((area) => area.id !== draft?.id && area.points.length >= MIN_AREA_POINTS)
        .map((area) => {
          const [cx, cy] = screen(centroid(area.points));
          return (
            <g key={area.id} data-testid="heat-limit-area">
              <polygon
                points={path(area.points)}
                fill="none"
                stroke={AREA_COLOR}
                strokeWidth={1.5}
                strokeDasharray="6 4"
              />
              {area.name && (
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill={AREA_COLOR}
                  style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 3 }}
                >
                  {area.name}
                </text>
              )}
            </g>
          );
        })}

      {draft && (
        <g data-testid="heat-limit-draft-shape">
          {draft.points.length >= MIN_AREA_POINTS ? (
            <polygon
              points={path(draft.points)}
              fill={DRAFT_COLOR}
              fillOpacity={0.15}
              stroke={DRAFT_COLOR}
              strokeWidth={2}
            />
          ) : (
            <polyline points={path(draft.points)} fill="none" stroke={DRAFT_COLOR} strokeWidth={2} />
          )}
          {draft.points.map((point, index) => {
            const [x, y] = screen(point);
            return (
              <circle
                key={index}
                data-testid="heat-limit-handle"
                cx={x}
                cy={y}
                r={HANDLE_RADIUS}
                fill="#ffffff"
                stroke={DRAFT_COLOR}
                strokeWidth={2}
                style={{ pointerEvents: 'all', cursor: 'move', touchAction: 'none' }}
                onPointerDown={onHandleDown(index)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  editor.removePoint(index);
                }}
              >
                <title>{t('heat_limit_handle_hint')}</title>
              </circle>
            );
          })}
        </g>
      )}
    </svg>
  );
};
