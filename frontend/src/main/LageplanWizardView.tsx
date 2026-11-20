import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useLocation as useRouterLocation,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { Spinner } from 'react-bootstrap';
import { enqueueSnackbar } from 'notistack';
import ImageCanvasStage, {
  type PlanScaleValues,
} from '../components/ui/ImageCanvasStage.tsx';
import LageplanKlemmliste from './LageplanKlemmliste';
import DmTransferStep from './DmTransferStep';
import PillButton from '../components/ui/kit/PillButton';
import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { getBackendUrl } from '../backendUrl';
import type { HeatLimitation } from '../components/device/sensorHeatmapTypes';
import HeatLimitationStage from '../components/device/HeatLimitationStage';
import { staffFlags } from './access';
import { isLorawanProject, planVisualization } from './projectType';
import '../components/ui/kit/kit.css';
import './LageplanWizard.css';
import {
  Notice,
  StepCard,
  TargetStepContext,
  LageplanWizardDialogs,
} from './LageplanWizardComponents';
import {
  LageplanDeviceStep,
  LageplanLocationStep,
  LageplanPlansStep,
} from './LageplanWizardSetupSteps';
import {
  LageplanManualSensorPlacement,
  LageplanPointsStep,
} from './LageplanWizardPointSteps';
import {
  defaultDeviceRanges,
  deviceLabel,
  type DeviceRange,
  type ImportedCad,
  type MeasurePoint,
  type MeasurePointsResponse,
  planLabel,
  placedFromPoints,
  type PointSource,
  rangesProblem,
  requestReason,
  rotatedPoint,
  type WizardConfirmAction,
  type WizardDevice,
  type WizardLageplan,
  type WizardLocation,
  type WizardSensor,
} from './lageplanWizardUtils';

/** A toast once something is stored - failures stay in the wizard's notice.
 * The same message twice at once (the alignment, stored by itself while
 * the sliders move) shows once. */
const toastSaved = (message: string) =>
  enqueueSnackbar(message, { variant: 'success', preventDuplicate: true });

// -- the wizard ---------------------------------------------------------------

const LageplanWizardView = () => {
  const auth = useAuth();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  // Backend: every measure_points endpoint (load + uploads) requires
  // module_devices_edit; storing the alignment (/v1/location/update/)
  // requires module_locations_edit.
  const canEditDevices = hasPermission('module_devices_edit');
  const canEditLocation = hasPermission('module_locations_edit');
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(
    null,
  );
  const [locations, setLocations] = useState<WizardLocation[]>([]);
  const [locationLoading, setLocationLoading] = useState(false);
  const [cadPayload, setCadPayload] = useState<ImportedCad | null>(null);
  const [measurePoints, setMeasurePoints] = useState<MeasurePoint[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  // Bumped to reload the measure points (e.g. after a JSON import).
  const [reloadKey, setReloadKey] = useState(0);

  // Step 3: the location's Lageplans (active ones first, as the backend
  // orders them) and the one the next steps work on.
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

  // Step 4, "Manually set sensors": the location's devices and the points
  // placed on the plans - stored only with "Save manual sensors".
  const [pointSource, setPointSource] = useState<PointSource>('cad');
  const [devices, setDevices] = useState<WizardDevice[]>([]);
  const [placedSensors, setPlacedSensors] = useState<WizardSensor[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<number | null>(null);
  const [placementDirty, setPlacementDirty] = useState(false);
  // Step 2 (for the CAD/JSON/TXT import of step 4): the devices the
  // imported points are connected to,
  // each with its sensors (a plan's sensors can be split over devices).
  const [deviceRanges, setDeviceRanges] = useState<DeviceRange[]>([]);
  // Step 5: measure points cut out (O + drag) - left off every plan until
  // inserted on one (I + click); nothing is stored before.
  const [cutPoints, setCutPoints] = useState<MeasurePoint[]>([]);
  const cutIds = useMemo(
    () => new Set(cutPoints.map((point) => Number(point.id))),
    [cutPoints],
  );

  // ?location=<location pk> (as everywhere else, e.g. from the device
  // overview) preselects the location; the selection is kept there.
  const [searchParams] = useSearchParams();
  const requestedLocation = Number(searchParams.get('location'));
  // ?plan=<lageplan id> (e.g. from /analyse) preselects that plan of the
  // location - once, with the first plans loaded.
  const requestedPlan = useRef<number | null>(
    Number(searchParams.get('plan')) || null,
  );
  // Step 7 (heat limitations): staff and superusers, like the backend.
  const staff = staffFlags(auth?.user).isStaffOrSuperuser;

  // Opened at a step (#wizard-..., e.g. from the checklist's "Beheben"):
  // scroll there once the location is chosen - again while its plans and
  // points load and push the step down, until the user scrolls themselves.
  // The step is kept apart from the URL: the browser marked no :target (the
  // step wasn't rendered yet), and nothing that rewrites the URL may lose it.
  const { hash, search } = useRouterLocation();
  const navigate = useNavigate();
  const [targetStep, setTargetStep] = useState<string | null>(
    () => hash.slice(1) || null,
  );
  useEffect(() => {
    if (hash.length > 1) {
      setTargetStep(hash.slice(1));
    }
  }, [hash]);
  useEffect(() => {
    const target = targetStep;
    if (!target || selectedLocationId === null) {
      return undefined;
    }
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    const scroll = () => {
      if (!stopped) {
        document
          .getElementById(target)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    const timers = [0, 600, 1500].map((delay) =>
      window.setTimeout(scroll, delay),
    );
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
    events.forEach((event) =>
      window.addEventListener(event, stop, { passive: true }),
    );
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      events.forEach((event) => window.removeEventListener(event, stop));
    };
  }, [targetStep, selectedLocationId]);

  // Everything below step 1 belongs to the selected location.
  const selectLocation = (next: WizardLocation | null) => {
    // ?location= names the selection (?plan= was read already). Only when
    // it changes - and with the #anchor kept: setSearchParams would drop it.
    const params = new URLSearchParams(search);
    if (next?.id != null) {
      params.set('location', String(next.id));
    } else {
      params.delete('location');
    }
    params.delete('plan');
    if (params.toString() !== new URLSearchParams(search).toString()) {
      navigate(
        { search: params.toString() ? `?${params}` : '', hash },
        { replace: true },
      );
    }
    setSelectedLocationId(next ? next.project_id : null);
    setPointSource(
      next && isLorawanProject(next.project_type) ? 'manual' : 'cad',
    );
    setCadPayload(null);
    setMeasurePoints([]);
    setLageplans([]);
    setSelectedPlanId(null);
    setAddingPlan(false);
    setDevices([]);
    setPlacedSensors([]);
    setActiveDeviceId(null);
    setPlacementDirty(false);
    setDeviceRanges([]);
    setCutPoints([]);
    setError('');
  };

  const selectedLocation = useMemo(
    () =>
      locations.find((loc) => loc.project_id === selectedLocationId) ?? null,
    [locations, selectedLocationId],
  );

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
  }, [auth]);

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

  useEffect(() => {
    if (selectedLocationId === null) {
      return;
    }

    let cancelled = false;
    setIsProcessing(true);
    setError('');

    void axiosConfig
      .perform_get(
        auth,
        `/v1/status/measure_points/?location_id=${selectedLocationId}&with_lageplan=true&with_devices=true`,
        (response) => {
          if (cancelled) {
            return;
          }

          const data = (response?.data ?? {}) as MeasurePointsResponse;
          const points = Array.isArray(data.points) ? data.points : [];
          const loadedDevices = Array.isArray(data.devices) ? data.devices : [];
          const loadedPlans = Array.isArray(data.lageplans)
            ? data.lageplans
            : [];
          const placed = placedFromPoints(points, loadedDevices);
          setMeasurePoints(points);
          // Cut points as stored now - gone ones leave the clipboard.
          setCutPoints((current) =>
            current.flatMap((cut) =>
              points.filter((point) => Number(point.id) === Number(cut.id)),
            ),
          );
          setDevices(loadedDevices);
          setPlacedSensors(placed);
          setActiveDeviceId(null);
          setPlacementDirty(false);
          setDeviceRanges(defaultDeviceRanges(points, loadedDevices));
          if (placed.length) {
            setPointSource('manual');
          }

          // Existing plans are ready to use: the one ?plan= asks for, else
          // keep the picked one, else the main (first) one.
          const wanted = requestedPlan.current;
          requestedPlan.current = null;
          const preselected =
            wanted != null && loadedPlans.some((plan) => plan.id === wanted)
              ? wanted
              : null;
          setLageplans(loadedPlans);
          setSelectedPlanId(
            (current) =>
              preselected ??
              (loadedPlans.some((plan) => plan.id === current)
                ? current
                : (loadedPlans[0]?.id ?? null)),
          );
        },
        (fetchError) => {
          if (!cancelled) {
            setError(
              `Could not load measure points: ${(fetchError as Error).message}`,
            );
          }
        },
      )
      .finally(() => {
        if (!cancelled) {
          setIsProcessing(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [auth, selectedLocationId, reloadKey]);

  // -- plans ------------------------------------------------------------------

  const selectedPlan =
    lageplans.find((plan) => plan.id === selectedPlanId) ?? null;
  // Points without (a known) Lageplan sit on the main plan - the same rule
  // as the status view's plan views.
  const mainPlanId = lageplans[0]?.id ?? null;
  const planIds = useMemo(
    () => new Set(lageplans.map((plan) => plan.id)),
    [lageplans],
  );
  const belongsTo = (planRef: unknown, planId: number | null) => {
    const id = planRef == null ? null : Number(planRef);
    return id !== null && planIds.has(id)
      ? id === planId
      : planId === mainPlanId;
  };

  const sourceMeta = useMemo(
    () =>
      selectedPlan?.url
        ? {
            fileName: planLabel(selectedPlan),
            imageUrl: getBackendUrl(selectedPlan.url),
            offset_x: selectedPlan.offset_x ?? 0,
            offset_y: selectedPlan.offset_y ?? 0,
            scale_x: selectedPlan.scale_x ?? 1,
            scale_y: selectedPlan.scale_y ?? 1,
            flip_x: selectedPlan.flip_x ?? false,
            // Vertically flipped unless the plan says otherwise (the default of new plans).
            flip_y: selectedPlan.flip_y ?? true,
            reference_x: selectedPlan.reference_x ?? null,
            reference_y: selectedPlan.reference_y ?? null,
            meters_per_pixel: selectedPlan.meters_per_pixel ?? null,
          }
        : null,
    [selectedPlan],
  );

  const updatePlan = (planId: number, values: Partial<WizardLageplan>) =>
    setLageplans((current) =>
      current.map((plan) =>
        plan.id === planId ? { ...plan, ...values } : plan,
      ),
    );

  const selectPlan = (planId: number) => {
    setSelectedPlanId(planId);
    setActiveDeviceId(null);
    setAddingPlan(false);
  };

  const handleJsonUpload = (response?: Record<string, unknown>) => {
    // The JSON import answers with the uploaded file, not the stored points.
    setError('');
    setReloadKey((key) => key + 1);
    const count = Array.isArray(response?.data) ? response.data.length : null;
    toastSaved(
      count === null
        ? 'Measure points imported and saved.'
        : `${count} measure point(s) imported and saved.`,
    );
  };

  // DWG/DXF and TXT both go through upload_cad, which returns the stored points.
  const handleCadUpload = (response: Record<string, unknown>) => {
    const valid = response as ImportedCad;
    if (!valid || !Array.isArray(valid.points)) {
      setError('The CAD upload did not return valid measure points.');
      return;
    }

    setCadPayload(valid);
    setMeasurePoints(valid.points);
    setPlacedSensors(placedFromPoints(valid.points, devices));
    setPlacementDirty(false);
    setError('');
    toastSaved(`${valid.points.length} measure point(s) imported and saved.`);
  };

  const handleSaveSliders = async (values: {
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
    flipY: boolean;
  }) => {
    if (selectedLocationId === null || selectedPlanId === null) {
      setError(
        'Select a location and a Lageplan before storing the alignment.',
      );
      return;
    }

    const planId = selectedPlanId;
    setIsProcessing(true);
    setError('');
    await axiosConfig.perform_post(
      auth,
      '/v1/location/update/',
      {
        location_id: selectedLocationId,
        lageplan_id: planId,
        offset_x: values.offsetX,
        offset_y: values.offsetY,
        scale_x: values.scaleX,
        scale_y: values.scaleY,
        flip_y: values.flipY,
      },
      () => {
        updatePlan(planId, {
          offset_x: values.offsetX,
          offset_y: values.offsetY,
          scale_x: values.scaleX,
          scale_y: values.scaleY,
          flip_y: values.flipY,
        });
        setIsProcessing(false);
        toastSaved('Alignment saved.');
      },
      (saveError) => {
        setError(`Could not store alignment: ${requestReason(saveError)}`);
        setIsProcessing(false);
      },
    );
  };

  // Metric scale of the picked Lageplan (reference point + meters per pixel).
  const handleSaveScale = async (values: PlanScaleValues) => {
    if (selectedLocationId === null || selectedPlanId === null) {
      setError('Select a location and a Lageplan before storing the scale.');
      return;
    }

    const planId = selectedPlanId;
    setIsProcessing(true);
    setError('');
    await axiosConfig.perform_post(
      auth,
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
        toastSaved(
          values.meters_per_pixel != null
            ? `Scale saved (${Number(values.meters_per_pixel.toPrecision(4))} m per pixel).`
            : 'Reference point saved.',
        );
      },
      (saveError) => {
        setError(`Could not store the scale: ${requestReason(saveError)}`);
        setIsProcessing(false);
      },
    );
  };

  // Step 5 cleared, cropped or rotated the plan image
  // (measure_points/edit_lageplan): the stored plan - a new file, for a crop
  // or rotation also the moved alignment, reference point and heat
  // limitations; a rotation also turned the plan's measure points.
  const handleImageEdited = (response: Record<string, unknown>) => {
    const plan = response?.lageplan as WizardLageplan | undefined;
    if (plan?.id) {
      updatePlan(plan.id, plan);
    }
    if (response?.direction === 'cw' || response?.direction === 'ccw') {
      const clockwise = response.direction === 'cw';
      const turned = (
        Array.isArray(response.points) ? response.points : []
      ) as Array<Record<string, unknown>>;
      const byId = new Map(turned.map((point) => [Number(point.id), point]));
      const merged = measurePoints.map(
        (point) => byId.get(Number(point.id)) ?? point,
      );
      setMeasurePoints(merged);
      if (!placementDirty) {
        setPlacedSensors(placedFromPoints(merged, devices));
      } else if (plan?.id) {
        // Not stored yet - turned here like the stored ones.
        const flipY = plan.flip_y ?? true;
        setPlacedSensors((current) =>
          current.map((sensor) => {
            if (!belongsTo(sensor.lageplanId, plan.id)) {
              return sensor;
            }
            const [nx, ny] = rotatedPoint(
              sensor.nx,
              sensor.ny,
              flipY,
              clockwise,
            );
            return { ...sensor, nx, ny };
          }),
        );
      }
      toastSaved(
        `Lageplan rotated and saved - ${turned.length} measure point(s) turned with it.`,
      );
      return;
    }
    toastSaved(
      response?.message === 'Lageplan cropped.'
        ? 'Lageplan cropped and saved - the sensors kept their place.'
        : 'Area cleared and saved.',
    );
  };

  // Step 5 removed measure points (D + drag, measure_points/remove): they
  // leave the list; the rest keep their sensor_order.
  const handlePointsRemoved = (response: Record<string, unknown>) => {
    const removed = new Set(
      (Array.isArray(response?.point_ids) ? response.point_ids : []).map(
        Number,
      ),
    );
    const remaining = measurePoints.filter(
      (point) => !removed.has(Number(point.id)),
    );
    setMeasurePoints(remaining);
    if (!placementDirty) {
      setPlacedSensors(placedFromPoints(remaining, devices));
    }
    toastSaved(`${removed.size} measure point(s) removed.`);
  };

  // Step 5 cut points out (O + drag): kept here, on every plan, until inserted.
  const handleCut = (points: Array<Record<string, unknown>>) => {
    const ids = new Set(points.map((point) => Number(point.id)));
    setCutPoints((current) => [
      ...current.filter((point) => !ids.has(Number(point.id))),
      ...points,
    ]);
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
    const moved = (
      Array.isArray(response?.points) ? response.points : []
    ) as Array<Record<string, unknown>>;
    const byId = new Map(moved.map((point) => [Number(point.id), point]));
    setMeasurePoints((current) =>
      current.map((point) => byId.get(Number(point.id)) ?? point),
    );
    setCutPoints((current) =>
      current.filter((point) => !byId.has(Number(point.id))),
    );
    toastSaved(
      action === 'insert'
        ? `${moved.length} measure point(s) inserted on “${planNameOf(selectedPlanId)}” and saved.`
        : `${moved.length} measure point(s) aligned and saved.`,
    );
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
    setLageplans((current) => [
      plan,
      ...current.filter((existing) => existing.id !== plan.id),
    ]);
    selectPlan(plan.id);
    toastSaved(`Lageplan "${planLabel(plan)}" uploaded and selected.`);
  };

  // -- manual placement -------------------------------------------------------

  const placedIds = useMemo(
    () => new Set(placedSensors.map((sensor) => sensor.deviceId)),
    [placedSensors],
  );
  const activeDevice =
    devices.find((device) => device.id === activeDeviceId) ?? null;
  // Saving replaces every point of the location, also the imported ones.
  const replacedPointCount =
    measurePoints.length - placedFromPoints(measurePoints, devices).length;
  // Imported points (CAD/JSON/TXT) are connected to these devices
  // (StatusViewSet._point_devices).
  const usedRanges = deviceRanges.filter((range) => range.deviceId != null);
  // ... and go onto the picked Lageplan, replacing only the points on it
  // (cad_import.store_measure_points) - without one, onto the main plan.
  const importPayload = {
    location_id: selectedLocationId,
    ...(selectedPlanId !== null ? { lageplan_id: selectedPlanId } : {}),
    point_devices: JSON.stringify(
      usedRanges.map((range) => ({
        device_id: range.deviceId,
        from: range.from.trim() || 1,
        to: range.to.trim(),
      })),
    ),
  };
  const deviceRangesProblem = rangesProblem(deviceRanges);
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
    setPlacedSensors((current) =>
      current.some((sensor) => sensor.deviceId === placed.deviceId)
        ? current.map((sensor) =>
            sensor.deviceId === placed.deviceId ? placed : sensor,
          )
        : [...current, placed],
    );
    setPlacementDirty(true);
    // Continue with the next sensor that has no point yet.
    const next = devices.find(
      (device) => device.id !== activeDevice.id && !placedIds.has(device.id),
    );
    setActiveDeviceId(next ? next.id : null);
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
    setPlacedSensors(placedFromPoints(measurePoints, devices));
    setActiveDeviceId(null);
    setPlacementDirty(false);
  };

  const handleSaveManualSensors = async () => {
    if (selectedLocationId === null) {
      return;
    }

    setIsProcessing(true);
    setError('');
    await axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/',
      {
        location_id: selectedLocationId,
        points: placedSensors.map((sensor) => ({
          x: Number(sensor.nx.toFixed(6)),
          y: Number(sensor.ny.toFixed(6)),
          device_id: sensor.deviceId,
          // Without one the point keeps its plan (see measure_points POST).
          lageplan_id: sensor.lageplanId ?? undefined,
        })),
      },
      (response) => {
        const stored = Array.isArray(response?.data?.points)
          ? response.data.points
          : [];
        setMeasurePoints(stored);
        setPlacedSensors(placedFromPoints(stored, devices));
        setActiveDeviceId(null);
        setPlacementDirty(false);
        setIsProcessing(false);
        toastSaved(`${stored.length} sensor(s) saved.`);
      },
      (saveError) => {
        setError(`Could not store the sensors: ${requestReason(saveError)}`);
        setIsProcessing(false);
      },
    );
  };

  // -- removing ---------------------------------------------------------------

  // Removes a Lageplan with the measure points on it
  // (StatusViewSet.delete_lageplan), then reloads the location's points.
  const deletePlan = (plan: WizardLageplan) => {
    if (selectedLocationId === null) {
      return;
    }
    setIsProcessing(true);
    setError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/delete_lageplan/',
      { location_id: selectedLocationId, lageplan_id: plan.id },
      (response: { data?: { removed_points?: number } }) => {
        setConfirmAction(null);
        setLageplans((current) =>
          current.filter((existing) => existing.id !== plan.id),
        );
        setReloadKey((key) => key + 1);
        const removed = response?.data?.removed_points ?? 0;
        toastSaved(
          `Lageplan "${planLabel(plan)}" removed${removed ? ` with ${removed} measure point(s)` : ''}.`,
        );
      },
      (deleteError) => {
        setConfirmAction(null);
        setError(
          `Could not remove the Lageplan: ${requestReason(deleteError)}`,
        );
        setIsProcessing(false);
      },
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
      setRenaming(null);
      return;
    }
    setIsProcessing(true);
    setError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/rename_lageplan/',
      { location_id: selectedLocationId, lageplan_id: plan.id, name: trimmed },
      (response: { data?: { name?: string | null } }) => {
        const stored = response?.data?.name ?? null;
        updatePlan(plan.id, { name: stored });
        setRenaming(null);
        setIsProcessing(false);
        toastSaved(
          `Lageplan renamed to “${planLabel({ ...plan, name: stored })}”.`,
        );
      },
      (renameError) => {
        setRenaming(null);
        setError(
          `Could not rename the Lageplan: ${requestReason(renameError)}`,
        );
        setIsProcessing(false);
      },
    );
  };

  // Moves a plan one place earlier (-1) or later (+1) and stores the order
  // (StatusViewSet.order_lageplans). The first is the main plan - when it
  // changes, the points without a plan are tied to the old one (backend and
  // here), so they stay where they are shown.
  const movePlan = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (
      selectedLocationId === null ||
      target < 0 ||
      target >= lageplans.length
    ) {
      return;
    }
    const previous = lageplans;
    const reordered = [...previous];
    [reordered[index], reordered[target]] = [
      reordered[target],
      reordered[index],
    ];
    const oldMainId = previous[0]?.id ?? null;
    setLageplans(reordered);
    setIsProcessing(true);
    setError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/order_lageplans/',
      {
        location_id: selectedLocationId,
        lageplan_ids: reordered.map((plan) => plan.id),
      },
      () => {
        if (oldMainId !== null && reordered[0].id !== oldMainId) {
          setMeasurePoints((current) =>
            current.map((point) =>
              point.lageplan == null
                ? { ...point, lageplan: oldMainId }
                : point,
            ),
          );
          setPlacedSensors((current) =>
            current.map((sensor) =>
              sensor.lageplanId == null
                ? { ...sensor, lageplanId: oldMainId }
                : sensor,
            ),
          );
        }
        setIsProcessing(false);
      },
      (orderError) => {
        setLageplans(previous);
        setError(`Could not change the order: ${requestReason(orderError)}`);
        setIsProcessing(false);
      },
    );
  };

  // Removes every measure point of the location (an empty replace).
  const clearMeasurePoints = () => {
    if (selectedLocationId === null) {
      return;
    }
    setIsProcessing(true);
    setError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/',
      { location_id: selectedLocationId, points: [] },
      () => {
        setConfirmAction(null);
        setMeasurePoints([]);
        setPlacedSensors([]);
        setActiveDeviceId(null);
        setPlacementDirty(false);
        setCadPayload(null);
        setIsProcessing(false);
        toastSaved('All measure points of the location removed.');
      },
      (clearError) => {
        setConfirmAction(null);
        setError(
          `Could not clear the measure points: ${requestReason(clearError)}`,
        );
        setIsProcessing(false);
      },
    );
  };

  const pointsOnPlan = (planId: number) =>
    measurePoints.filter((point) => belongsTo(point.lageplan, planId)).length;

  // -- steps ------------------------------------------------------------------

  const renderStepOne = () => (
    <LageplanLocationStep
      locations={locations}
      selectedLocationId={selectedLocationId}
      selectedLocation={selectedLocation}
      loading={locationLoading}
      onChange={selectLocation}
    />
  );

  const renderStepTwo = () => (
    <LageplanPlansStep
      locationId={selectedLocationId}
      hasImage={!!sourceMeta?.imageUrl}
      plans={lageplans}
      selectedPlan={selectedPlan}
      selectedPlanId={selectedPlanId}
      isProcessing={isProcessing}
      addingPlan={addingPlan}
      onAddingPlanChange={setAddingPlan}
      onSelectPlan={selectPlan}
      onMovePlan={movePlan}
      pointsOnPlan={pointsOnPlan}
      onRenamePlan={(plan) => setRenaming({ plan, name: plan.name ?? '' })}
      onRemovePlan={(plan) => setConfirmAction({ kind: 'plan', plan })}
      onSourceUpload={handleSourceUpload}
    />
  );

  const manualPlacement =
    pointSource === 'manual' && selectedLocationId !== null;
  const manualSensors = (
    <LageplanManualSensorPlacement
      devices={devices}
      placedSensors={placedSensors}
      selectedPlanId={selectedPlanId}
      activeDeviceId={activeDeviceId}
      activeDevice={activeDevice}
      planSensors={planSensors}
      placementDirty={placementDirty}
      isProcessing={isProcessing}
      replacedPointCount={replacedPointCount}
      hasPlanImage={Boolean(sourceMeta?.imageUrl)}
      planNameOf={planNameOf}
      belongsTo={belongsTo}
      onActiveDeviceChange={setActiveDeviceId}
      onRemoveActiveSensor={removeActiveSensor}
      onDiscardPlacement={discardPlacement}
      onSaveManualSensors={handleSaveManualSensors}
    />
  );

  const renderStepDevice = () => (
    <LageplanDeviceStep
      locationId={selectedLocationId}
      devices={devices}
      measurePoints={measurePoints}
      deviceRanges={deviceRanges}
      onDeviceRangesChange={setDeviceRanges}
      deviceRangesProblem={deviceRangesProblem}
    />
  );

  const renderStepThree = () => (
    <LageplanPointsStep
      locationId={selectedLocationId}
      measurePoints={measurePoints}
      placementDirty={placementDirty}
      isProcessing={isProcessing}
      pointSource={pointSource}
      onPointSourceChange={setPointSource}
      deviceRangesProblem={deviceRangesProblem}
      importPayload={importPayload}
      onCadUpload={handleCadUpload}
      onJsonUpload={handleJsonUpload}
      manualSensors={manualSensors}
      plans={lageplans}
      selectedPlanId={selectedPlanId}
      cadPayload={cadPayload}
      planNameOf={planNameOf}
      pointsOnPlan={pointsOnPlan}
      importReplaces={
        measurePoints.filter((point) =>
          belongsTo(point.lageplan, selectedPlanId),
        ).length
      }
      onClear={() => setConfirmAction({ kind: 'points' })}
    />
  );

  const renderStepFour = () => (
    <StepCard number={5} step="align" title="Align and inspect">
      {!sourceMeta?.imageUrl ? (
        <Notice tone="warning" testId="lageplan-wizard-canvas-needs-plan">
          Select or add a Lageplan in step 3 before using the canvas editor.
        </Notice>
      ) : (
        <ImageCanvasStage
          // A different plan starts with its own view (zoom, tools).
          key={selectedPlanId ?? 'none'}
          testId="lageplan-wizard-canvas"
          sourceMeta={sourceMeta}
          imageUrl={sourceMeta.imageUrl}
          title={
            manualPlacement
              ? `${planSensors.length} sensor(s) placed on this plan`
              : planVisualization(selectedLocation?.project_type) === 'lines'
                ? `${planPoints.length} dm sensor(s) on this plan`
                : `${planPoints.length} measure point(s) on this plan`
          }
          fileName={sourceMeta.fileName}
          locationId={selectedLocationId ?? undefined}
          lageplanId={selectedPlanId ?? undefined}
          measurePoints={planPoints}
          // smartex dm: every sensor is a band line (nx/ny -> nx_end/ny_end).
          lineSensors={
            planVisualization(selectedLocation?.project_type) === 'lines'
          }
          deviceLabels={deviceLabels}
          devicePairStarts={devicePairStarts}
          withSliders={canEditLocation}
          onSaveSliders={canEditLocation ? handleSaveSliders : undefined}
          onSaveScale={canEditLocation ? handleSaveScale : undefined}
          onImageEdited={canEditLocation ? handleImageEdited : undefined}
          onPointsRemoved={canEditLocation ? handlePointsRemoved : undefined}
          cutPoints={cutPoints}
          onCut={canEditLocation ? handleCut : undefined}
          onDiscardCut={() => setCutPoints([])}
          onPointsPlaced={canEditLocation ? handlePointsPlaced : undefined}
          placement={
            manualPlacement
              ? {
                  sensors: planSensors,
                  activeDeviceId,
                  activeLabel: activeDevice
                    ? deviceLabel(activeDevice)
                    : undefined,
                  onPlace: placeActiveSensor,
                  onMove: moveSensor,
                  onSelect: setActiveDeviceId,
                }
              : undefined
          }
        />
      )}
    </StepCard>
  );

  // Step 6 (optional): the band ends of dm sensors read from the plan.
  const planBands = planPoints.filter(
    (point) => point.nx_end != null && point.ny_end != null,
  ).length;
  const renderStepDmTransfer = () => (
    <StepCard
      number={6}
      step="dmTransfer"
      title="dm-Transfer (optional)"
      done={planPoints.length > 0 && planBands === planPoints.length}
    >
      <DmTransferStep
        // Fresh proposals per location and plan.
        key={`${selectedLocationId}-${selectedPlanId}`}
        locationId={selectedLocationId}
        plan={
          selectedPlan ? { id: selectedPlan.id, url: selectedPlan.url } : null
        }
        pointCount={planPoints.length}
        pointsWithEnd={planBands}
        canEdit={canEditDevices}
        onStored={() => setReloadKey((key) => key + 1)}
      />
    </StepCard>
  );

  // Step 7: the areas the heatmap's heat field is limited to (staff).
  const renderStepHeatLimits = () => (
    <StepCard
      number={7}
      step="heatLimits"
      title="Heat limitations"
      done={Boolean(selectedPlan?.heat_limitations?.length)}
    >
      {!selectedPlan?.url ? (
        <Notice tone="warning" testId="lageplan-wizard-heat-limits-need-plan">
          Select or add a Lageplan in step 3 to draw its heat limitations.
        </Notice>
      ) : (
        <>
          <div className="lageplan-muted mb-2">
            The heatmap shows heat only inside these areas of “
            {planLabel(selectedPlan)}” - outside them the plan is dimmed here.
            Without an area the heat is not limited.
          </div>
          <HeatLimitationStage
            // A different plan starts with its own view and draft.
            key={selectedPlan.id}
            plan={selectedPlan}
            plans={lageplans}
            points={
              manualPlacement
                ? planSensors.map((sensor) => ({
                    nx: sensor.nx,
                    ny: sensor.ny,
                  }))
                : planPoints
            }
            editable={staff}
            onChange={(planId: number, areas: HeatLimitation[]) =>
              updatePlan(planId, { heat_limitations: areas })
            }
            testId="lageplan-wizard-heat-limits"
          />
        </>
      )}
    </StepCard>
  );

  // Step 8: the MEA documents from Airtable and the Klemmliste's sensor names.
  const renderStepKlemmliste = () => (
    <StepCard
      number={8}
      step="klemmliste"
      title={staff ? 'MEA documents and Klemmliste' : 'Klemmliste'}
    >
      {selectedLocationId === null ? (
        <Notice
          tone="warning"
          testId="lageplan-wizard-klemmliste-needs-location"
        >
          Select a location in step 1 first.
        </Notice>
      ) : (
        <LageplanKlemmliste
          // A new location starts the step afresh: its documents, no Klemmliste of the last one.
          key={selectedLocationId}
          auth={auth}
          locationId={selectedLocationId}
          devices={devices.map((device) => ({
            id: device.id,
            label: deviceLabel(device),
            first_sensor_order: device.first_sensor_order,
          }))}
          staff={staff}
          // The new names show on the plan and in the sensor list.
          onNamesApplied={() => setReloadKey((key) => key + 1)}
        />
      )}
    </StepCard>
  );

  if (!permissionsLoading && !canEditDevices) {
    return (
      <div data-testid="page-lageplan-wizard">
        <Notice tone="warning" testId="lageplan-wizard-no-permission">
          You do not have permission to edit measure points.
        </Notice>
      </div>
    );
  }

  return (
    <TargetStepContext.Provider value={targetStep}>
      <div className="lageplan-wizard" data-testid="page-lageplan-wizard">
        <div className="lageplan-wizard-head">
          <div>
            <div className="lageplan-wizard-title">Lageplan wizard</div>
            <div className="lageplan-muted">
              Pick a location, choose or add a Lageplan, set the measure points
              and align them on the plan.
            </div>
          </div>
          {isProcessing && (
            <span
              className="d-flex align-items-center gap-2 lageplan-muted"
              data-testid="lageplan-wizard-processing"
            >
              <Spinner animation="border" size="sm" />
              Processing…
            </span>
          )}
          <div className="ms-auto">
            <PillButton
              variant="ghost"
              label="Reset"
              onClick={() => selectLocation(null)}
              testId="lageplan-wizard-reset"
            />
          </div>
        </div>

        {error && (
          <Notice tone="danger" testId="lageplan-wizard-error">
            {error}
          </Notice>
        )}

        {renderStepOne()}
        {renderStepDevice()}
        {renderStepTwo()}
        {renderStepThree()}
        {renderStepFour()}
        {renderStepDmTransfer()}
        {staff && renderStepHeatLimits()}
        {renderStepKlemmliste()}

        <LageplanWizardDialogs
          confirmAction={confirmAction}
          renaming={renaming}
          measurePointCount={measurePoints.length}
          isProcessing={isProcessing}
          pointsOnPlan={pointsOnPlan}
          onConfirmActionChange={setConfirmAction}
          onDeletePlan={deletePlan}
          onClearMeasurePoints={clearMeasurePoints}
          onRenamingChange={setRenaming}
          onRenamePlan={renamePlan}
        />
      </div>
    </TargetStepContext.Provider>
  );
};

export default LageplanWizardView;
