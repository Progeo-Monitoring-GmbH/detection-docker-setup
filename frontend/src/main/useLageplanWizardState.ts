/**
 * The Lageplan wizard's state (LageplanWizardView.tsx): the selected
 * location with its plans, measure points and devices, loaded from
 * /v1/status/measure_points/, and what the steps derive from it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useLocation as useRouterLocation,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { enqueueSnackbar } from 'notistack';
import type { AuthContextType } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  deviceLabel,
  type ImportedCad,
  type MeasurePoint,
  type MeasurePointsResponse,
  planLabel,
  placedFromPoints,
  type PointSource,
  requestReason,
  type WizardConfirmAction,
  type WizardDevice,
  type WizardLageplan,
  type WizardLocation,
  type WizardSensor,
} from './lageplanWizardUtils';
import {
  belongsToPlan,
  importPayloadFor,
  pointSourceFor,
  requestedPlanId,
  keptCutPoints,
  locationSearch,
  measurePointsData,
  nextSelectedPlanId,
  planSourceMeta,
} from './lageplanWizardLogic';

/** A toast once something is stored - failures stay in the wizard's notice.
 * The same message twice at once (the alignment, stored by itself while
 * the sliders move) shows once. */
export const toastSaved = (message: string) =>
  enqueueSnackbar(message, { variant: 'success', preventDuplicate: true });

/** "Processing" and the notice's error - and storing something with both. */
const useWizardRequests = (auth: AuthContextType) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');

  /** Stores something: shows "Processing", a failure in the notice
   * ("<failure>: <reason>", after `onFail`). */
  const post = (
    url: string,
    body: Record<string, unknown>,
    onOk: Parameters<typeof axiosConfig.perform_post>[3],
    failure: string,
    onFail?: () => void,
  ) => {
    setIsProcessing(true);
    setError('');
    return axiosConfig.perform_post(auth, url, body, onOk, (postError) => {
      onFail?.();
      setError(`${failure}: ${requestReason(postError)}`);
      setIsProcessing(false);
    });
  };

  return { isProcessing, setIsProcessing, error, setError, post };
};

/** Step 2: the location's Lageplans (active ones first, as the backend
 * orders them), the one the next steps work on and the plan dialogs. */
const usePlanState = () => {
  const [lageplans, setLageplans] = useState<WizardLageplan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [addingPlan, setAddingPlan] = useState(false);
  // What the confirm dialog asks about: removing a Lageplan, or clearing
  // every measure point of the location.
  const [confirmAction, setConfirmAction] =
    useState<WizardConfirmAction | null>(null);
  // The rename dialog: the plan and the name typed so far.
  const [renaming, setRenaming] = useState<{
    plan: WizardLageplan;
    name: string;
  } | null>(null);

  return {
    lageplans,
    setLageplans,
    selectedPlanId,
    setSelectedPlanId,
    addingPlan,
    setAddingPlan,
    confirmAction,
    setConfirmAction,
    renaming,
    setRenaming,
  };
};

/** Steps 8, 3 and 4: the devices, the sensors placed by hand, the import's
 * device ranges and the cut points. */
const usePlacementState = () => {
  // Step 3, "Manually set sensors": the location's devices and the points
  // placed on the plans - stored only with "Save manual sensors".
  const [pointSource, setPointSource] = useState<PointSource>('cad');
  const [devices, setDevices] = useState<WizardDevice[]>([]);
  const [placedSensors, setPlacedSensors] = useState<WizardSensor[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<number | null>(null);
  const [placementDirty, setPlacementDirty] = useState(false);
  // Step 4: measure points cut out (O + drag) - left off every plan until
  // inserted on one (I + click); nothing is stored before.
  const [cutPoints, setCutPoints] = useState<MeasurePoint[]>([]);

  return {
    pointSource,
    setPointSource,
    devices,
    setDevices,
    placedSensors,
    setPlacedSensors,
    activeDeviceId,
    setActiveDeviceId,
    placementDirty,
    setPlacementDirty,
    cutPoints,
    setCutPoints,
  };
};

/** Everything below step 1: the selected location's plans, points and devices. */
export const useLageplanWizardState = (auth: AuthContextType) => {
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(
    null,
  );
  const [cadPayload, setCadPayload] = useState<ImportedCad | null>(null);
  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  // Bumped to reload the measure points (e.g. after a JSON import).
  const [reloadKey, setReloadKey] = useState(0);
  const requests = useWizardRequests(auth);
  const planState = usePlanState();
  const placement = usePlacementState();

  // ?plan=<lageplan id> (e.g. from /analyse) preselects that plan of the
  // location - once, with the first plans loaded.
  const [searchParams] = useSearchParams();
  const requestedPlan = useRef(requestedPlanId(searchParams));

  /** Starts over with another location (or none). */
  const resetTo = (next: WizardLocation | null) => {
    setSelectedLocationId(next?.project_id ?? null);
    placement.setPointSource(pointSourceFor(next));
    setCadPayload(null);
    setMeasurePoints([]);
    planState.setLageplans([]);
    planState.setSelectedPlanId(null);
    planState.setAddingPlan(false);
    placement.setDevices([]);
    placement.setPlacedSensors([]);
    placement.setActiveDeviceId(null);
    placement.setPlacementDirty(false);
    placement.setCutPoints([]);
    requests.setError('');
  };

  /** The stored points replace the shown ones (and the unsaved placement). */
  const showStoredPoints = (points: MeasurePoint[]) => {
    setMeasurePoints(points);
    placement.setPlacedSensors(placedFromPoints(points, placement.devices));
    placement.setPlacementDirty(false);
  };

  return {
    auth,
    selectedLocationId,
    cadPayload,
    setCadPayload,
    measurePoints,
    setMeasurePoints,
    reloadKey,
    reload: () => setReloadKey((key) => key + 1),
    ...requests,
    ...planState,
    ...placement,
    requestedPlan,
    resetTo,
    showStoredPoints,
  };
};

export type LageplanWizardState = ReturnType<typeof useLageplanWizardState>;

/** Step 1's choice: the locations with a project id (only they can carry
 * measure points). */
export const useWizardLocations = (
  auth: AuthContextType,
  setError: (error: string) => void,
) => {
  const [locations, setLocations] = useState<WizardLocation[]>([]);
  const [locationLoading, setLocationLoading] = useState(false);

  useEffect(() => {
    const fetchLocations = async () => {
      setLocationLoading(true);
      try {
        await axiosConfig.perform_get(
          auth,
          '/v1/location/min/',
          (response) => {
            const list = Array.isArray(response?.data) ? response.data : [];

            // Only locations with a project id can carry measure points.
            setLocations(
              (list as WizardLocation[]).filter(
                (loc) => Number.isFinite(loc.project_id) && loc.project_id > 0,
              ),
            );
          },
          (fetchError) => {
            setError(
              `Could not load available locations: ${(fetchError as Error).message}`,
            );
          },
        );
      } finally {
        setLocationLoading(false);
      }
    };

    void fetchLocations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

  return { locations, locationLoading };
};

/**
 * The selected location, kept in ?location=<location pk> (as everywhere
 * else, e.g. from the device overview), which also preselects it.
 */
export const useLocationSelection = (
  locations: WizardLocation[],
  state: LageplanWizardState,
) => {
  const { hash, search } = useRouterLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedLocation = Number(searchParams.get('location'));
  const { selectedLocationId } = state;

  // Everything below step 1 belongs to the selected location.
  const selectLocation = (next: WizardLocation | null) => {
    // ?location= names the selection (?plan= was read already). Only when
    // it changes - and with the #anchor kept: setSearchParams would drop it.
    const nextSearch = locationSearch(search, next?.id ?? null);
    if (nextSearch !== null) {
      navigate({ search: nextSearch, hash }, { replace: true });
    }
    state.resetTo(next);
  };

  // Once the locations are there, and whenever ?location= changes from
  // outside (favorites bar): select the one it names. The picker sets the
  // parameter itself - then it names the selected location already.
  useEffect(() => {
    if (!locations.length || !requestedLocation) {
      return;
    }
    const requested = locations.find((loc) => loc.id === requestedLocation);
    if (requested && requested.project_id !== selectedLocationId) {
      selectLocation(requested);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations, requestedLocation]);

  const selectedLocation = useMemo(
    () =>
      locations.find((loc) => loc.project_id === selectedLocationId) ?? null,
    [locations, selectedLocationId],
  );

  return { selectedLocation, selectLocation };
};

/** Loads the selected location's points, devices and plans - again when
 * `reload` was called. */
export const useMeasurePointsLoad = (state: LageplanWizardState) => {
  const { auth, selectedLocationId, reloadKey } = state;

  useEffect(() => {
    if (selectedLocationId === null) {
      return;
    }

    let cancelled = false;
    state.setIsProcessing(true);
    state.setError('');

    void axiosConfig
      .perform_get(
        auth,
        `/v1/status/measure_points/?location_id=${selectedLocationId}&with_lageplan=true&with_devices=true`,
        (response) => {
          if (!cancelled) {
            applyLoaded(state, response?.data);
          }
        },
        (fetchError) => {
          if (!cancelled) {
            state.setError(
              `Could not load measure points: ${(fetchError as Error).message}`,
            );
          }
        },
      )
      .finally(() => {
        if (!cancelled) {
          state.setIsProcessing(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, selectedLocationId, reloadKey]);
};

/** A measure_points answer replaces the location's points, devices and plans. */
const applyLoaded = (state: LageplanWizardState, data: unknown) => {
  const { points, devices, plans } = measurePointsData(
    data as MeasurePointsResponse | undefined,
  );
  const placed = placedFromPoints(points, devices);
  state.setMeasurePoints(points);
  state.setCutPoints((current) => keptCutPoints(current, points));
  state.setDevices(devices);
  state.setPlacedSensors(placed);
  state.setActiveDeviceId(null);
  state.setPlacementDirty(false);
  if (placed.length) {
    state.setPointSource('manual');
  }

  // Existing plans are ready to use: the one ?plan= asks for, else keep the
  // picked one, else the main (first) one.
  const wanted = state.requestedPlan.current;
  state.requestedPlan.current = null;
  state.setLageplans(plans);
  state.setSelectedPlanId((current) =>
    nextSelectedPlanId(plans, wanted, current),
  );
};

/** The devices' names and pair-1 sensor orders, by id (canvas tooltips). */
const useDeviceMaps = (devices: WizardDevice[]) => {
  const deviceLabels = useMemo(
    () =>
      Object.fromEntries(
        devices.map((device) => [device.id, deviceLabel(device)]),
      ),
    [devices],
  );
  const devicePairStarts = useMemo(
    () =>
      Object.fromEntries(
        devices.map((device) => [device.id, device.first_sensor_order ?? 1]),
      ),
    [devices],
  );
  return { deviceLabels, devicePairStarts };
};

/** What the steps show of the state: the picked plan, its points and
 * sensors, the import's settings. */
export const useWizardDerived = (state: LageplanWizardState) => {
  const {
    lageplans,
    selectedPlanId,
    measurePoints,
    placedSensors,
    cutPoints,
    devices,
    activeDeviceId,
    selectedLocationId,
    pointSource,
  } = state;

  const cutIds = useMemo(
    () => new Set(cutPoints.map((point) => Number(point.id))),
    [cutPoints],
  );
  const selectedPlan =
    lageplans.find((plan) => plan.id === selectedPlanId) ?? null;
  const mainPlanId = lageplans[0]?.id ?? null;
  const planIds = useMemo(
    () => new Set(lageplans.map((plan) => plan.id)),
    [lageplans],
  );
  const belongsTo = (planRef: unknown, planId: number | null) =>
    belongsToPlan(planRef, planId, planIds, mainPlanId);
  const sourceMeta = useMemo(
    () => planSourceMeta(selectedPlan),
    [selectedPlan],
  );

  const placedIds = useMemo(
    () => new Set(placedSensors.map((sensor) => sensor.deviceId)),
    [placedSensors],
  );
  const activeDevice =
    devices.find((device) => device.id === activeDeviceId) ?? null;
  const { deviceLabels, devicePairStarts } = useDeviceMaps(devices);

  // What the canvas shows: the points / sensors of the picked plan.
  const planPoints = measurePoints.filter(
    (point) =>
      belongsTo(point.lageplan, selectedPlanId) &&
      !cutIds.has(Number(point.id)),
  );
  const planSensors = placedSensors.filter((sensor) =>
    belongsTo(sensor.lageplanId, selectedPlanId),
  );
  const planNameOf = (planId: number | null) => {
    const plan = lageplans.find((candidate) => candidate.id === planId);
    return plan ? planLabel(plan) : 'the main plan';
  };
  const pointsOnPlan = (planId: number | null) =>
    measurePoints.filter((point) => belongsTo(point.lageplan, planId)).length;
  // Sensors set by hand (step 3) are placed on the canvas (step 4).
  const manualPlacement =
    pointSource === 'manual' && selectedLocationId !== null;

  return {
    manualPlacement,
    // What the heat limitations (step 6) show on the plan.
    heatPoints: manualPlacement
      ? planSensors.map((sensor) => ({ nx: sensor.nx, ny: sensor.ny }))
      : planPoints,
    selectedPlan,
    belongsTo,
    sourceMeta,
    placedIds,
    activeDevice,
    // Saving replaces every point of the location, also the imported ones.
    replacedPointCount:
      measurePoints.length - placedFromPoints(measurePoints, devices).length,
    // Imported points (CAD/JSON/TXT) go to the device whose inputs measure
    // them (step 8, backend helper/device_inputs.device_lookup).
    importPayload: importPayloadFor(selectedLocationId, selectedPlanId),
    deviceLabels,
    devicePairStarts,
    planPoints,
    planSensors,
    planNameOf,
    pointsOnPlan,
    // What an import onto the picked plan replaces (cut points too).
    importReplaces: pointsOnPlan(selectedPlanId),
  };
};

export type LageplanWizardDerived = ReturnType<typeof useWizardDerived>;
