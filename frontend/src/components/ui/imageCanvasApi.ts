/**
 * The server calls of the plan canvas (ImageCanvasStage): storing the
 * alignment, auto alignment, image edits and moving / removing measure
 * points. Each one reports through its callbacks.
 */
import axiosConfig from '../../axiosConfig';
import type { AuthContextType } from '../../../hooks/CoreAuthProvider';
import type { AlignmentValues, CutItem } from './imageCanvasGeometry';
import type { ImageEdit } from './imageCanvasModes';

type Auth = AuthContextType | undefined;
type Answer = Record<string, unknown>;
/** The plan a request is about. */
export type PlanIds = { locationId: number; lageplanId: number };

/** Why a request failed: the server's reason, else the error message. */
const requestReason = (requestError: unknown) =>
  (requestError as { response?: { data?: { reason?: string } } })?.response?.data?.reason ??
  (requestError as Error).message;

/** An alignment as the server takes it. */
const alignmentPayload = (values: AlignmentValues) => ({
  offset_x: values.offsetX,
  offset_y: values.offsetY,
  scale_x: values.scaleX,
  scale_y: values.scaleY,
  flip_y: values.flipY,
});

const planPayload = (ids: Partial<PlanIds>) => ({ location_id: ids.locationId, lageplan_id: ids.lageplanId });

const answerOf = (response: { data?: Answer } | undefined) => response?.data ?? {};

/** Stores the alignment onto the plan (fire and forget). */
export const postAlignment = (auth: Auth, ids: Partial<PlanIds>, values: AlignmentValues) =>
  void axiosConfig.perform_post(
    auth,
    '/v1/location/update/',
    { ...planPayload(ids), ...alignmentPayload(values) },
    () => {},
    () => {},
  );

/** Auto alignment (measure_points/auto_align): the backend fits the points
 * onto the plan's orange lines, starting from `before`. */
export const postAutoAlign = (
  auth: Auth,
  ids: Partial<PlanIds>,
  before: AlignmentValues,
  onDone: (alignment: AlignmentValues, score: number, matched: boolean) => void,
  onFail: (reason: string) => void,
) =>
  void axiosConfig.perform_post(
    auth,
    '/v1/status/measure_points/auto_align/',
    { ...planPayload(ids), ...alignmentPayload(before) },
    (response: { data?: Answer }) => {
      const data = answerOf(response) as {
        offset_x: number;
        offset_y: number;
        scale_x: number;
        scale_y: number;
        flip_y: boolean;
        score: number;
        matched: boolean;
      };
      onDone(
        { offsetX: data.offset_x, offsetY: data.offset_y, scaleX: data.scale_x, scaleY: data.scale_y, flipY: data.flip_y },
        data.score,
        data.matched,
      );
    },
    (error: unknown) => {
      const reason = (error as { response?: { data?: { reason?: string } } })?.response?.data?.reason;
      onFail(reason || 'The auto alignment failed');
    },
  );

/** An image edit (measure_points/edit_lageplan), stored with the alignment shown. */
export const postImageEdit = (
  auth: Auth,
  ids: PlanIds,
  action: ImageEdit | 'rotate',
  extra: Record<string, unknown>,
  values: AlignmentValues,
  onDone: (answer: Answer) => void,
  onFail: (message: string) => void,
) =>
  void axiosConfig.perform_post(
    auth,
    '/v1/status/measure_points/edit_lageplan/',
    { ...planPayload(ids), action, ...extra, ...alignmentPayload(values) },
    (response: { data?: Answer }) => onDone(answerOf(response)),
    (editFailure: unknown) => {
      const what = { crop: 'crop the plan', clear: 'clear the area', rotate: 'rotate the plan' }[action];
      onFail(`Could not ${what}: ${requestReason(editFailure)}`);
    },
  );

/** Deletes measure points (measure_points/remove). */
export const postRemovePoints = (
  auth: Auth,
  locationId: number,
  pointIds: number[],
  onDone: (answer: Answer) => void,
  onFail: (message: string) => void,
) =>
  void axiosConfig.perform_post(
    auth,
    '/v1/status/measure_points/remove/',
    { location_id: locationId, point_ids: pointIds },
    (response: { data?: Answer }) => onDone(answerOf(response)),
    (removeFailure: unknown) => onFail(`Could not remove the measure points: ${requestReason(removeFailure)}`),
  );

/** Renumbers dots (measure_points/reorder, "Repair order"): the numbers move to
 * the dots picked for them - a permutation of the points' own numbers. */
export const postReorder = (
  auth: Auth,
  locationId: number,
  orders: Array<{ id: number; sensor_order: number }>,
  onDone: (answer: Answer) => void,
  onFail: (message: string) => void,
) =>
  void axiosConfig.perform_post(
    auth,
    '/v1/status/measure_points/reorder/',
    { location_id: locationId, orders },
    (response: { data?: Answer }) => onDone(answerOf(response)),
    (reorderFailure: unknown) => onFail(`Could not store the new order: ${requestReason(reorderFailure)}`),
  );

/** Moves points onto a plan at new normalized positions (measure_points/place). */
export const postPlacePoints = (
  auth: Auth,
  ids: PlanIds,
  positions: CutItem[],
  action: 'insert' | 'align',
  onDone: (answer: Answer) => void,
  onFail: (message: string) => void,
) =>
  void axiosConfig.perform_post(
    auth,
    '/v1/status/measure_points/place/',
    {
      ...planPayload(ids),
      points: positions.map(({ id, start, end }) => ({
        id,
        nx: start[0],
        ny: start[1],
        ...(end ? { nx_end: end[0], ny_end: end[1] } : {}),
      })),
    },
    (response: { data?: Answer }) => onDone(answerOf(response)),
    (placeFailure: unknown) =>
      onFail(
        `Could not ${action === 'insert' ? 'insert the cut points' : 'store the aligned points'}: ${requestReason(placeFailure)}`,
      ),
  );
