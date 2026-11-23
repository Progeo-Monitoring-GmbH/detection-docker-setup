/**
 * What the Lageplan wizard's steps do (LageplanWizardView.tsx): manage the
 * plans, edit them on the canvas, import and place measure points - each
 * stored on the server, then shown.
 */
import { enqueueSnackbar } from 'notistack';
import type { HeatLimitation } from '../components/device/sensorHeatmapTypes';
import type { PlanScaleValues } from '../components/ui/ImageCanvasStage.tsx';
import {
  deviceLabel,
  type ImportedCad,
  type MeasurePoint,
  planLabel,
  placedFromPoints,
  type WizardLageplan,
  type WizardSensor,
} from './lageplanWizardUtils';
import {
  answerPoints,
  deviceRangesPayload,
  imageEditedMessage,
  jsonImportMessage,
  manualSensorsPayload,
  mergedPoints,
  nextUnplacedDeviceId,
  plansWithUpload,
  pointsById,
  pointsTiedTo,
  removedPointIds,
  rotatedSensors,
  rotationOf,
  scaleSavedMessage,
  sensorsTiedTo,
  swappedPlans,
  withCutPoints,
  withPlacedSensor,
} from './lageplanWizardLogic';
import {
  type LageplanWizardDerived,
  type LageplanWizardState,
  toastSaved,
} from './useLageplanWizardState';

type AlignmentValues = {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  flipY: boolean;
};

/** Steps 3 and 5: picking, uploading, renaming, ordering and removing
 * Lageplans, and storing a plan's alignment and scale. */
export const usePlanActions = (state: LageplanWizardState) => {
  const {
    selectedLocationId,
    selectedPlanId,
    lageplans,
    setLageplans,
    setError,
    setIsProcessing,
    post,
  } = state;

  const updatePlan = (planId: number, values: Partial<WizardLageplan>) =>
    setLageplans((current) =>
      current.map((plan) =>
        plan.id === planId ? { ...plan, ...values } : plan,
      ),
    );

  const selectPlan = (planId: number) => {
    state.setSelectedPlanId(planId);
    state.setActiveDeviceId(null);
    state.setAddingPlan(false);
  };

  // RedDropbox (instantFileUpload) passes the upload response, which carries
  // the stored Lageplan - see StatusViewSet.upload_measure_points_from_png.
  // The new plan is active and the newest, so it heads the list.
  const handleSourceUpload = (response: Record<string, unknown>) => {
    const plan = response?.lageplan as WizardLageplan | undefined;
    if (!plan?.id) {
      setError('The upload response did not contain the stored Lageplan.');
      return;
    }

    setError('');
    setLageplans((current) => plansWithUpload(current, plan));
    selectPlan(plan.id);
    toastSaved(`Lageplan "${planLabel(plan)}" uploaded and selected.`);
  };

  const handleSaveSliders = async (values: AlignmentValues) => {
    if (selectedLocationId === null || selectedPlanId === null) {
      setError(
        'Select a location and a Lageplan before storing the alignment.',
      );
      return;
    }

    const planId = selectedPlanId;
    const alignment = {
      offset_x: values.offsetX,
      offset_y: values.offsetY,
      scale_x: values.scaleX,
      scale_y: values.scaleY,
      flip_y: values.flipY,
    };
    await post(
      '/v1/location/update/',
      { location_id: selectedLocationId, lageplan_id: planId, ...alignment },
      () => {
        updatePlan(planId, alignment);
        setIsProcessing(false);
        toastSaved('Alignment saved.');
      },
      'Could not store alignment',
    );
  };

  // Metric scale of the picked Lageplan (reference point + meters per pixel).
  const handleSaveScale = async (values: PlanScaleValues) => {
    if (selectedLocationId === null || selectedPlanId === null) {
      setError('Select a location and a Lageplan before storing the scale.');
      return;
    }

    const planId = selectedPlanId;
    await post(
      '/v1/location/update_scale/',
      { location_id: selectedLocationId, lageplan_id: planId, ...values },
      (response) => {
        const stored = response?.data ?? {};
        updatePlan(planId, {
          reference_x: stored.reference_x ?? null,
          reference_y: stored.reference_y ?? null,
          meters_per_pixel: stored.meters_per_pixel ?? null,
        });
        setIsProcessing(false);
        toastSaved(scaleSavedMessage(values.meters_per_pixel));
      },
      'Could not store the scale',
    );
  };

  // Removes a Lageplan with the measure points on it
  // (StatusViewSet.delete_lageplan), then reloads the location's points.
  const deletePlan = (plan: WizardLageplan) => {
    if (selectedLocationId === null) {
      return;
    }
    void post(
      '/v1/status/measure_points/delete_lageplan/',
      { location_id: selectedLocationId, lageplan_id: plan.id },
      (response: { data?: { removed_points?: number } }) => {
        state.setConfirmAction(null);
        setLageplans((current) =>
          current.filter((existing) => existing.id !== plan.id),
        );
        state.reload();
        const removed = response?.data?.removed_points ?? 0;
        toastSaved(
          `Lageplan "${planLabel(plan)}" removed${removed ? ` with ${removed} measure point(s)` : ''}.`,
        );
      },
      'Could not remove the Lageplan',
      () => state.setConfirmAction(null),
    );
  };

  // Renames a Lageplan (StatusViewSet.rename_lageplan); an empty name clears
  // it, the plan is then shown by its file name.
  const renamePlan = (plan: WizardLageplan, name: string) => {
    if (selectedLocationId === null) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === (plan.name ?? '').trim()) {
      state.setRenaming(null);
      return;
    }
    void post(
      '/v1/status/measure_points/rename_lageplan/',
      { location_id: selectedLocationId, lageplan_id: plan.id, name: trimmed },
      (response: { data?: { name?: string | null } }) => {
        const stored = response?.data?.name ?? null;
        updatePlan(plan.id, { name: stored });
        state.setRenaming(null);
        setIsProcessing(false);
        toastSaved(
          `Lageplan renamed to “${planLabel({ ...plan, name: stored })}”.`,
        );
      },
      'Could not rename the Lageplan',
      () => state.setRenaming(null),
    );
  };

  // Moves a plan one place earlier (-1) or later (+1) and stores the order
  // (StatusViewSet.order_lageplans). The first is the main plan - when it
  // changes, the points without a plan are tied to the old one (backend and
  // here), so they stay where they are shown.
  const movePlan = (index: number, delta: -1 | 1) => {
    const reordered = swappedPlans(lageplans, index, delta);
    if (selectedLocationId === null || reordered === null) {
      return;
    }
    const previous = lageplans;
    const oldMainId = previous[0]?.id ?? null;
    setLageplans(reordered);
    void post(
      '/v1/status/measure_points/order_lageplans/',
      {
        location_id: selectedLocationId,
        lageplan_ids: reordered.map((plan) => plan.id),
      },
      () => {
        if (oldMainId !== null && reordered[0].id !== oldMainId) {
          state.setMeasurePoints((current) => pointsTiedTo(current, oldMainId));
          state.setPlacedSensors((current) =>
            sensorsTiedTo(current, oldMainId),
          );
        }
        setIsProcessing(false);
      },
      'Could not change the order',
      () => setLageplans(previous),
    );
  };

  return {
    updatePlan,
    selectPlan,
    startRename: (plan: WizardLageplan) =>
      state.setRenaming({ plan, name: plan.name ?? '' }),
    confirmRemove: (plan: WizardLageplan) =>
      state.setConfirmAction({ kind: 'plan', plan }),
    setHeatLimitations: (planId: number, areas: HeatLimitation[]) =>
      updatePlan(planId, { heat_limitations: areas }),
    handleSourceUpload,
    handleSaveSliders,
    handleSaveScale,
    deletePlan,
    renamePlan,
    movePlan,
  };
};

/** Step 5's edits on the canvas: the plan image cleared, cropped or rotated,
 * points removed, cut out, inserted or aligned. */
export const useCanvasEdits = (
  state: LageplanWizardState,
  derived: LageplanWizardDerived,
  updatePlan: (planId: number, values: Partial<WizardLageplan>) => void,
) => {
  const { measurePoints, placementDirty, devices } = state;

  // Step 5 cleared, cropped or rotated the plan image
  // (measure_points/edit_lageplan): the stored plan - a new file, for a crop
  // or rotation also the moved alignment, reference point and heat
  // limitations; a rotation also turned the plan's measure points.
  const handleImageEdited = (response: Record<string, unknown>) => {
    const plan = response?.lageplan as WizardLageplan | undefined;
    if (plan?.id) {
      updatePlan(plan.id, plan);
    }
    const rotation = rotationOf(response);
    if (!rotation) {
      toastSaved(imageEditedMessage(response));
      return;
    }
    const turned = answerPoints(response);
    const merged = mergedPoints(measurePoints, pointsById(turned));
    state.setMeasurePoints(merged);
    if (!placementDirty) {
      state.setPlacedSensors(placedFromPoints(merged, devices));
    } else if (plan?.id) {
      // Not stored yet - turned here like the stored ones.
      state.setPlacedSensors((current) =>
        rotatedSensors(
          current,
          (sensor) => derived.belongsTo(sensor.lageplanId, plan.id),
          plan.flip_y ?? true,
          rotation.clockwise,
        ),
      );
    }
    toastSaved(
      `Lageplan rotated and saved - ${turned.length} measure point(s) turned with it.`,
    );
  };

  // Step 5 removed measure points (D + drag, measure_points/remove): they
  // leave the list; the rest keep their sensor_order.
  const handlePointsRemoved = (response: Record<string, unknown>) => {
    const removed = removedPointIds(response);
    const remaining = measurePoints.filter(
      (point) => !removed.has(Number(point.id)),
    );
    state.setMeasurePoints(remaining);
    if (!placementDirty) {
      state.setPlacedSensors(placedFromPoints(remaining, devices));
    }
    toastSaved(`${removed.size} measure point(s) removed.`);
  };

  // Step 5 cut points out (O + drag): kept here, on every plan, until inserted.
  const handleCut = (points: Array<Record<string, unknown>>) => {
    state.setCutPoints((current) => withCutPoints(current, points));
    enqueueSnackbar(
      `${points.length} measure point(s) cut out - hold I and click on a plan to insert them.`,
      { variant: 'info', preventDuplicate: true },
    );
  };

  // Step 5 inserted the cut points (I + click) or aligned a group (L) -
  // measure_points/place answers with the moved points, now on this plan.
  const handlePointsPlaced = (
    response: Record<string, unknown>,
    action: 'insert' | 'align',
  ) => {
    const moved = answerPoints(response);
    const byId = pointsById(moved);
    state.setMeasurePoints((current) => mergedPoints(current, byId));
    state.setCutPoints((current) =>
      current.filter((point) => !byId.has(Number(point.id))),
    );
    toastSaved(
      action === 'insert'
        ? `${moved.length} measure point(s) inserted on “${derived.planNameOf(state.selectedPlanId)}” and saved.`
        : `${moved.length} measure point(s) aligned and saved.`,
    );
  };

  return {
    onDiscardCut: () => state.setCutPoints([]),
    onImageEdited: handleImageEdited,
    onPointsRemoved: handlePointsRemoved,
    onCut: handleCut,
    onPointsPlaced: handlePointsPlaced,
  };
};

/** Step 4: importing the points (CAD/JSON/TXT), placing sensors by hand,
 * clearing every point of the location. */
export const usePointActions = (
  state: LageplanWizardState,
  derived: LageplanWizardDerived,
) => {
  const {
    selectedLocationId,
    selectedPlanId,
    devices,
    activeDeviceId,
    setError,
    setIsProcessing,
    setPlacedSensors,
    setActiveDeviceId,
    setPlacementDirty,
    post,
  } = state;
  const { activeDevice } = derived;

  const handleJsonUpload = (response?: Record<string, unknown>) => {
    // The JSON import answers with the uploaded file, not the stored points.
    setError('');
    state.reload();
    toastSaved(jsonImportMessage(response));
  };

  // DWG/DXF and TXT both go through upload_cad, which returns the stored points.
  const handleCadUpload = (response: Record<string, unknown>) => {
    const valid = response as ImportedCad;
    if (!valid || !Array.isArray(valid.points)) {
      setError('The CAD upload did not return valid measure points.');
      return;
    }

    state.setCadPayload(valid);
    state.showStoredPoints(valid.points);
    setError('');
    toastSaved(`${valid.points.length} measure point(s) imported and saved.`);
  };

  // Removes every measure point of the location (an empty replace).
  const clearMeasurePoints = () => {
    if (selectedLocationId === null) {
      return;
    }
    void post(
      '/v1/status/measure_points/',
      { location_id: selectedLocationId, points: [] },
      () => {
        state.setConfirmAction(null);
        state.setMeasurePoints([]);
        setPlacedSensors([]);
        setActiveDeviceId(null);
        setPlacementDirty(false);
        state.setCadPayload(null);
        setIsProcessing(false);
        toastSaved('All measure points of the location removed.');
      },
      'Could not clear the measure points',
      () => state.setConfirmAction(null),
    );
  };

  const placeActiveSensor = (nx: number, ny: number) => {
    if (!activeDevice) {
      return;
    }
    // Placing a sensor that sits on another plan moves it to this one.
    const placed: WizardSensor = {
      deviceId: activeDevice.id,
      label: deviceLabel(activeDevice),
      nx,
      ny,
      lageplanId: selectedPlanId,
    };
    setPlacedSensors((current) => withPlacedSensor(current, placed));
    setPlacementDirty(true);
    // Continue with the next sensor that has no point yet.
    setActiveDeviceId(
      nextUnplacedDeviceId(devices, activeDevice.id, derived.placedIds),
    );
  };

  const moveSensor = (deviceId: number, nx: number, ny: number) => {
    setPlacedSensors((current) =>
      current.map((sensor) =>
        sensor.deviceId === deviceId
          ? { ...sensor, nx, ny, lageplanId: selectedPlanId }
          : sensor,
      ),
    );
    setPlacementDirty(true);
  };

  const removeActiveSensor = () => {
    setPlacedSensors((current) =>
      current.filter((sensor) => sensor.deviceId !== activeDeviceId),
    );
    setPlacementDirty(true);
  };

  const discardPlacement = () => {
    setPlacedSensors(placedFromPoints(state.measurePoints, devices));
    setActiveDeviceId(null);
    setPlacementDirty(false);
  };

  // Step 2 on its own: the devices' first sensors and their points.
  const saveDeviceRanges = async () => {
    if (selectedLocationId === null) {
      return;
    }
    await post(
      '/v1/status/measure_points/device_ranges/',
      deviceRangesPayload(selectedLocationId, state.deviceRanges),
      (response) => {
        setIsProcessing(false);
        state.reload();
        toastSaved(
          `Device ranges saved - ${Number(response?.data?.points ?? 0)} point(s) connected to their device.`,
        );
      },
      'Could not save the device ranges',
    );
  };

  const handleSaveManualSensors = async () => {
    if (selectedLocationId === null) {
      return;
    }

    await post(
      '/v1/status/measure_points/',
      {
        location_id: selectedLocationId,
        points: manualSensorsPayload(state.placedSensors),
      },
      (response) => {
        const stored: MeasurePoint[] = Array.isArray(response?.data?.points)
          ? response.data.points
          : [];
        state.showStoredPoints(stored);
        setActiveDeviceId(null);
        setIsProcessing(false);
        toastSaved(`${stored.length} sensor(s) saved.`);
      },
      'Could not store the sensors',
    );
  };

  // The canvas' placement mode (step 5) while sensors are set by hand.
  const placement = {
    sensors: derived.planSensors,
    activeDeviceId,
    activeLabel: activeDevice ? deviceLabel(activeDevice) : undefined,
    onPlace: placeActiveSensor,
    onMove: moveSensor,
    onSelect: setActiveDeviceId,
  };

  return {
    handleJsonUpload,
    handleCadUpload,
    confirmClear: () => state.setConfirmAction({ kind: 'points' }),
    clearMeasurePoints,
    removeActiveSensor,
    discardPlacement,
    handleSaveManualSensors,
    saveDeviceRanges,
    canvasPlacement: derived.manualPlacement ? placement : undefined,
  };
};
