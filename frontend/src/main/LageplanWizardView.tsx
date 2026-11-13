import React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Button, Spinner } from 'react-bootstrap';
import { CheckLg, ChevronLeft, ChevronRight, FileEarmarkPdf, PencilSquare, PlusLg } from 'react-bootstrap-icons';
import CadUploadDropbox from '../components/form/CadUploadDropbox.tsx';
import { enqueueSnackbar } from 'notistack';
import RedDropbox from '../components/form/RedDropbox.tsx';
import LocationPicker, {
  type PickableLocation,
} from '../components/location/LocationPicker';
import ImageCanvasStage, {
  type PlacedSensor,
  type PlanScaleValues,
} from '../components/ui/ImageCanvasStage.tsx';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import DeleteIconButton from '../components/ui/kit/DeleteIconButton';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { getBackendUrl } from '../backendUrl';
import type { SensorHeatmapLageplanData } from '../components/device/sensorHeatmapTypes';
import { isLorawanProject, planVisualization } from './projectType';
import '../components/ui/kit/kit.css';
import './LageplanWizard.css';
import { formatDate } from './dateFormat';

type ImportedCad = {
  location_id: number;
  /** The plan the points went onto. */
  lageplan_id?: number | null;
  /** Points imported - `points` lists all of the location. */
  stored: number;
  points: Array<Record<string, unknown>>;
  /** Sensor numbers also used on another plan. */
  warning?: string | null;
};

type WizardDevice = {
  id: number;
  mac?: string | null;
  hardware?: string | null;
  type?: string | null;
  raw_hash?: string | null;
  /** sensor_order of the device's pair 1 (ProgeoDevice.first_sensor_order). */
  first_sensor_order?: number | null;
};

/** Step 2: the sensors from..to (sensor_order, '' = open) of one device. */
type DeviceRange = { deviceId: number | null; from: string; to: string };

/** A Lageplan of the location (ProgeoLageplanSerializer). */
type WizardLageplan = SensorHeatmapLageplanData & { id: number };

type MeasurePointsResponse = {
  points?: Array<Record<string, unknown>>;
  // ?with_lageplan=1: every Lageplan of the location, active ones first.
  lageplans?: WizardLageplan[] | null;
  // ?with_devices=1: the devices a point can be assigned to.
  devices?: WizardDevice[];
};

/** A location of /v1/location/min/ (ProgeoLocationMinSerializer). The
 * measure_points endpoints address it by project id (their location_id). */
type WizardLocation = PickableLocation & {
  project_id: number;
  project_type?: number | null;
};

/** A hand-placed sensor and the Lageplan it was placed on (null: none yet,
 * shown on the main plan - see belongsTo). */
type WizardSensor = PlacedSensor & { lageplanId: number | null };

type PointSource = 'cad' | 'json' | 'txt' | 'manual';

const POINT_SOURCES: Array<{ value: PointSource; label: string }> = [
  { value: 'cad', label: 'CAD (DWG/DXF)' },
  { value: 'json', label: 'JSON' },
  { value: 'txt', label: 'TXT' },
  { value: 'manual', label: 'Manually set sensors' },
];


/** A measure point's normalized position after its plan turned by 90
 * degrees - as the backend turns the stored ones (lageplan_edit.rotated_point). */
const rotatedPoint = (nx: number, ny: number, flipY: boolean, clockwise: boolean): [number, number] => {
  const v = flipY ? 1 - ny : ny;
  const [nextNx, nextV] = clockwise ? [1 - v, nx] : [v, 1 - nx];
  return [nextNx, flipY ? 1 - nextV : nextV];
};

const getFileExt = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/** Devices are shown by their MAC; without one by hardware name / hash. */
const deviceLabel = (device: WizardDevice) =>
  device.mac || device.hardware || device.raw_hash || `#${device.id}`;

const planLabel = (plan: WizardLageplan) =>
  plan.name || plan.url?.split('/').pop() || `Lageplan #${plan.id}`;

/** Whether the plan's points were moved/scaled away from the defaults (the
 * vertical flip is one - new plans start flipped). */
const isAligned = (plan: WizardLageplan) =>
  Boolean(plan.offset_x || plan.offset_y) ||
  (plan.scale_x ?? 1) !== 1 ||
  (plan.scale_y ?? 1) !== 1;

/** How many of the points belong to each device. */
const pointsPerDevice = (points: Array<Record<string, unknown>>) => {
  const counts = new Map<number, number>();
  points.forEach((point) => {
    if (point.device != null) {
      const deviceId = Number(point.device);
      counts.set(deviceId, (counts.get(deviceId) ?? 0) + 1);
    }
  });
  return counts;
};

/** The hand-placed sensors among stored points (in sensor order): one point
 * per device - imported points connected to their device are many per device. */
const placedFromPoints = (
  points: Array<Record<string, unknown>>,
  devices: WizardDevice[],
): WizardSensor[] => {
  const counts = pointsPerDevice(points);
  return points
    .filter((point) => point.device != null && counts.get(Number(point.device)) === 1)
    .sort((a, b) => Number(a.sensor_order) - Number(b.sensor_order))
    .map((point) => {
      const deviceId = Number(point.device);
      const device = devices.find((candidate) => candidate.id === deviceId);
      return {
        deviceId,
        label: device ? deviceLabel(device) : `#${deviceId}`,
        nx: Number(point.nx),
        ny: Number(point.ny),
        lageplanId: point.lageplan == null ? null : Number(point.lageplan),
      };
    });
};

/** The devices imported points get connected to: as the stored imported
 * points are (each device's first sensor to its last), else all on the
 * location's only device. */
const defaultDeviceRanges = (
  points: Array<Record<string, unknown>>,
  devices: WizardDevice[],
): DeviceRange[] => {
  const imported = [...pointsPerDevice(points)]
    .filter(([deviceId, count]) => count > 1 && devices.some((device) => device.id === deviceId))
    .map(([deviceId]) => {
      const orders = points
        .filter((point) => Number(point.device) === deviceId)
        .map((point) => Number(point.sensor_order));
      const device = devices.find((candidate) => candidate.id === deviceId);
      return {
        deviceId,
        from: String(device?.first_sensor_order ?? Math.min(...orders)),
        to: String(Math.max(...orders)),
      };
    })
    .sort((a, b) => Number(a.from) - Number(b.from));
  if (imported.length) {
    // The last device takes every sensor from its first on.
    imported[imported.length - 1].to = '';
    return imported;
  }
  return devices.length === 1 ? [{ deviceId: devices[0].id, from: '1', to: '' }] : [];
};

/** Why the ranges can't be imported, or null. */
const rangesProblem = (ranges: DeviceRange[]): string | null => {
  const used = ranges.filter((range) => range.deviceId != null);
  if (new Set(used.map((range) => range.deviceId)).size !== used.length) {
    return 'Each device only once - its pair 1 is the first sensor of its range.';
  }
  const parsed = used
    .map((range) => ({
      from: range.from.trim() ? Number(range.from) : 1,
      to: range.to.trim() ? Number(range.to) : Infinity,
    }))
    .sort((a, b) => a.from - b.from);
  if (parsed.some((range) => !Number.isInteger(range.from) || range.from < 1 || range.to < range.from)) {
    return 'The sensors of a device run from 1 up (from <= to).';
  }
  if (parsed.some((range, index) => index > 0 && parsed[index - 1].to >= range.from)) {
    return 'The ranges of two devices overlap.';
  }
  return null;
};

const requestReason = (requestError: unknown) =>
  (requestError as { response?: { data?: { reason?: string } } })?.response
    ?.data?.reason ?? (requestError as Error).message;

/** A toast once something is stored - failures stay in the wizard's notice.
 * The same message twice at once (the alignment, stored by itself while
 * the sliders move) shows once. */
const toastSaved = (message: string) =>
  enqueueSnackbar(message, { variant: 'success', preventDuplicate: true });

// -- building blocks ----------------------------------------------------------

const Notice = ({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: React.ReactNode;
}) => <div className={`lageplan-notice lageplan-notice--${tone}`}>{children}</div>;

/** A tile's state chip - grey, or `main` (blue) / `active` (green). */
const Chip = ({ children, variant }: { children: React.ReactNode; variant?: 'main' | 'active' }) => (
  <span className={variant ? `lageplan-chip lageplan-chip--${variant}` : 'lageplan-chip'}>{children}</span>
);

const StepCard = ({
  number,
  title,
  done,
  actions,
  children,
}: {
  number: number;
  title: string;
  done?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <PanelCard
    title={
      <span className="lageplan-step-title">
        <span className={done ? 'lageplan-step-number lageplan-step-number--done' : 'lageplan-step-number'}>
          {done ? <CheckLg size={13} /> : number}
        </span>
        {title}
      </span>
    }
    actions={actions}
  >
    {children}
  </PanelCard>
);

/** A Lageplan image as thumbnail - media needs the Authorization header, so
 * it's fetched as blob (like ImageCanvasStage); PDFs get a placeholder.
 * Mounted with key={url}, so a new image starts from a fresh state. */
const LageplanThumb = ({ url }: { url?: string | null }) => {
  const auth = useAuth();
  // `auth` changes identity with the route - not a reason to load again.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isPdf = getFileExt(url ?? '') === 'pdf';

  useEffect(() => {
    if (!url || isPdf) {
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void axiosConfig.perform_get(
      authRef.current,
      getBackendUrl(url),
      (response) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(response.data as Blob);
        setSrc(objectUrl);
      },
      () => {
        if (!cancelled) {
          setFailed(true);
        }
      },
      { responseType: 'blob' },
    );
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [url, isPdf]);

  return (
    <div className="lageplan-thumb">
      {src ? (
        <img src={src} alt="" />
      ) : isPdf ? (
        <FileEarmarkPdf size={26} />
      ) : failed || !url ? (
        'No preview'
      ) : (
        <Spinner animation="border" size="sm" />
      )}
    </div>
  );
};

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
  const [measurePoints, setMeasurePoints] = useState<
    Array<Record<string, unknown>>
  >([]);
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
  const [confirmAction, setConfirmAction] = useState<
    { kind: 'plan'; plan: WizardLageplan } | { kind: 'points' } | null
  >(null);
  // The rename dialog: the plan and the name typed so far.
  const [renaming, setRenaming] = useState<{ plan: WizardLageplan; name: string } | null>(null);

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
  const [cutPoints, setCutPoints] = useState<Array<Record<string, unknown>>>([]);
  const cutIds = useMemo(() => new Set(cutPoints.map((point) => Number(point.id))), [cutPoints]);

  // ?location=<location pk> (as everywhere else, e.g. from the device
  // overview) preselects the location; the selection is kept there.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedLocation = Number(searchParams.get('location'));
  const appliedRequest = useRef(false);

  // Everything below step 1 belongs to the selected location.
  const selectLocation = (next: WizardLocation | null) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next?.id != null) {
          params.set('location', String(next.id));
        } else {
          params.delete('location');
        }
        return params;
      },
      { replace: true },
    );
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

  // Once the locations are there: select the one ?location= names.
  useEffect(() => {
    if (appliedRequest.current || !locations.length) {
      return;
    }
    appliedRequest.current = true;
    const requested = locations.find((loc) => loc.id === requestedLocation);
    if (requested) {
      selectLocation(requested);
    }
    // Only for the first list - later the user picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations]);

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
            current.flatMap((cut) => points.filter((point) => Number(point.id) === Number(cut.id))),
          );
          setDevices(loadedDevices);
          setPlacedSensors(placed);
          setActiveDeviceId(null);
          setPlacementDirty(false);
          setDeviceRanges(defaultDeviceRanges(points, loadedDevices));
          if (placed.length) {
            setPointSource('manual');
          }

          // Existing plans are ready to use: keep the picked one, else the
          // main (first) one.
          setLageplans(loadedPlans);
          setSelectedPlanId((current) =>
            loadedPlans.some((plan) => plan.id === current)
              ? current
              : (loadedPlans[0]?.id ?? null),
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
    return id !== null && planIds.has(id) ? id === planId : planId === mainPlanId;
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
      current.map((plan) => (plan.id === planId ? { ...plan, ...values } : plan)),
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
    toastSaved(count === null ? 'Measure points imported and saved.' : `${count} measure point(s) imported and saved.`);
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
      setError('Select a location and a Lageplan before storing the alignment.');
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
      const turned = (Array.isArray(response.points) ? response.points : []) as Array<Record<string, unknown>>;
      const byId = new Map(turned.map((point) => [Number(point.id), point]));
      const merged = measurePoints.map((point) => byId.get(Number(point.id)) ?? point);
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
            const [nx, ny] = rotatedPoint(sensor.nx, sensor.ny, flipY, clockwise);
            return { ...sensor, nx, ny };
          }),
        );
      }
      toastSaved(`Lageplan rotated and saved - ${turned.length} measure point(s) turned with it.`);
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
      (Array.isArray(response?.point_ids) ? response.point_ids : []).map(Number),
    );
    const remaining = measurePoints.filter((point) => !removed.has(Number(point.id)));
    setMeasurePoints(remaining);
    if (!placementDirty) {
      setPlacedSensors(placedFromPoints(remaining, devices));
    }
    toastSaved(`${removed.size} measure point(s) removed.`);
  };

  // Step 5 cut points out (O + drag): kept here, on every plan, until inserted.
  const handleCut = (points: Array<Record<string, unknown>>) => {
    const ids = new Set(points.map((point) => Number(point.id)));
    setCutPoints((current) => [...current.filter((point) => !ids.has(Number(point.id))), ...points]);
    enqueueSnackbar(
      `${points.length} measure point(s) cut out - hold I and click on a plan to insert them.`,
      { variant: 'info', preventDuplicate: true },
    );
  };

  // Step 5 inserted the cut points (I + click) or aligned a group (L) -
  // measure_points/place answers with the moved points, now on this plan.
  const handlePointsPlaced = (response: Record<string, unknown>, action: 'insert' | 'align') => {
    const moved = (Array.isArray(response?.points) ? response.points : []) as Array<Record<string, unknown>>;
    const byId = new Map(moved.map((point) => [Number(point.id), point]));
    setMeasurePoints((current) => current.map((point) => byId.get(Number(point.id)) ?? point));
    setCutPoints((current) => current.filter((point) => !byId.has(Number(point.id))));
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
  const updateRange = (index: number, values: Partial<DeviceRange>) =>
    setDeviceRanges((current) =>
      current.map((range, position) => (position === index ? { ...range, ...values } : range)),
    );
  const deviceLabels = useMemo(
    () => Object.fromEntries(devices.map((device) => [device.id, deviceLabel(device)])),
    [devices],
  );
  const devicePairStarts = useMemo(
    () => Object.fromEntries(devices.map((device) => [device.id, device.first_sensor_order ?? 1])),
    [devices],
  );
  const connectedCount = (deviceId: number) =>
    measurePoints.filter((point) => Number(point.device) === deviceId).length;
  // What the canvas shows: the points / sensors of the picked plan.
  const planPoints = measurePoints.filter(
    (point) => belongsTo(point.lageplan, selectedPlanId) && !cutIds.has(Number(point.id)),
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
        setLageplans((current) => current.filter((existing) => existing.id !== plan.id));
        setReloadKey((key) => key + 1);
        const removed = response?.data?.removed_points ?? 0;
        toastSaved(
          `Lageplan "${planLabel(plan)}" removed${removed ? ` with ${removed} measure point(s)` : ''}.`,
        );
      },
      (deleteError) => {
        setConfirmAction(null);
        setError(`Could not remove the Lageplan: ${requestReason(deleteError)}`);
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
        toastSaved(`Lageplan renamed to “${planLabel({ ...plan, name: stored })}”.`);
      },
      (renameError) => {
        setRenaming(null);
        setError(`Could not rename the Lageplan: ${requestReason(renameError)}`);
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
    if (selectedLocationId === null || target < 0 || target >= lageplans.length) {
      return;
    }
    const previous = lageplans;
    const reordered = [...previous];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    const oldMainId = previous[0]?.id ?? null;
    setLageplans(reordered);
    setIsProcessing(true);
    setError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/order_lageplans/',
      { location_id: selectedLocationId, lageplan_ids: reordered.map((plan) => plan.id) },
      () => {
        if (oldMainId !== null && reordered[0].id !== oldMainId) {
          setMeasurePoints((current) =>
            current.map((point) => (point.lageplan == null ? { ...point, lageplan: oldMainId } : point)),
          );
          setPlacedSensors((current) =>
            current.map((sensor) => (sensor.lageplanId == null ? { ...sensor, lageplanId: oldMainId } : sensor)),
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
        setError(`Could not clear the measure points: ${requestReason(clearError)}`);
        setIsProcessing(false);
      },
    );
  };

  const pointsOnPlan = (planId: number) =>
    measurePoints.filter((point) => belongsTo(point.lageplan, planId)).length;

  // -- steps ------------------------------------------------------------------

  const renderStepOne = () => (
    <StepCard number={1} title="Location" done={!!selectedLocation}>
      <div className="lageplan-picker">
        <LocationPicker
          id="lageplan-location-picker"
          locations={locations}
          value={selectedLocationId}
          valueKey="project_id"
          onChange={selectLocation}
          loading={locationLoading}
        />
      </div>

      {!locations.length && !locationLoading && (
        <div className="lageplan-spaced">
          <Notice tone="warning">No locations are available yet.</Notice>
        </div>
      )}
    </StepCard>
  );

  const renderPlanTile = (plan: WizardLageplan, index: number) => {
    const selected = plan.id === selectedPlanId;
    const pointCount = pointsOnPlan(plan.id);
    const updated = plan.last_updated ? new Date(plan.last_updated) : null;
    return (
      // The tile's buttons sit next to (not inside) the tile's own button.
      <div key={plan.id} className="lageplan-tile-wrap">
        <button type="button" onClick={() => selectPlan(plan.id)} aria-pressed={selected} className="lageplan-tile">
          <LageplanThumb key={plan.url ?? ''} url={plan.url} />
          {selected && (
            <span className="lageplan-tile-check">
              <CheckLg size={13} />
            </span>
          )}
          <div className="lageplan-tile-text">
            <div title={planLabel(plan)} className="lageplan-tile-name">
              {planLabel(plan)}
            </div>
            <div className="lageplan-tile-meta">
              #{plan.id}
              {updated && !Number.isNaN(updated.getTime())
                ? ` · ${formatDate(updated, 'date')}`
                : ''}
              {` · ${pointCount} point(s)`}
            </div>
            <div className="lageplan-tile-chips">
              {index === 0 && lageplans.length > 1 && (
                <span title="The first plan - measure points without a plan show on it">
                  <Chip variant="main">Main plan</Chip>
                </span>
              )}
              {plan.is_active ? (
                <Chip variant="active">Active</Chip>
              ) : (
                <Chip>Inactive</Chip>
              )}
              {isAligned(plan) && <Chip>Aligned</Chip>}
              {plan.meters_per_pixel ? <Chip>Scale set</Chip> : null}
            </div>
          </div>
        </button>
        {lageplans.length > 1 && (
          <span className="lageplan-tile-order">
            <button
              type="button"
              title="Move earlier"
              aria-label={`Move “${planLabel(plan)}” earlier`}
              disabled={isProcessing || index === 0}
              onClick={() => movePlan(index, -1)}
              className="progeo-icon-button progeo-icon-button--small"
            >
              <ChevronLeft size={13} />
            </button>
            <span title={`Place ${index + 1} of ${lageplans.length}`} className="lageplan-tile-place">
              {index + 1}
            </span>
            <button
              type="button"
              title="Move later"
              aria-label={`Move “${planLabel(plan)}” later`}
              disabled={isProcessing || index === lageplans.length - 1}
              onClick={() => movePlan(index, 1)}
              className="progeo-icon-button progeo-icon-button--small"
            >
              <ChevronRight size={13} />
            </button>
          </span>
        )}
        <span className="lageplan-tile-actions">
          <button
            type="button"
            title="Rename Lageplan"
            aria-label="Rename Lageplan"
            disabled={isProcessing}
            onClick={() => setRenaming({ plan, name: plan.name ?? '' })}
            className="progeo-icon-button"
          >
            <PencilSquare size={14} />
          </button>
          <DeleteIconButton
            label="Remove Lageplan"
            disabled={isProcessing}
            onClick={() => setConfirmAction({ kind: 'plan', plan })}
          />
        </span>
      </div>
    );
  };

  const renderPlanUpload = () => (
    <div className="lageplan-upload">
      <div className="d-flex align-items-start gap-2">
        <div>
          <div className="lageplan-upload-title">Add a Lageplan</div>
          <div className="lageplan-muted lageplan-muted--small">
            Upload a PNG rendering of the plan - it is added to the existing
            ones and selected. A PDF export of the CAD plan is rendered as
            PNG, cropped to the plan.
          </div>
        </div>
        {lageplans.length > 0 && (
          <div className="ms-auto">
            <PillButton
              variant="ghost"
              label="Cancel"
              onClick={() => setAddingPlan(false)}
            />
          </div>
        )}
      </div>
      <div className="lageplan-upload-drops">
        <RedDropbox
          auth={auth}
          url="/v1/status/measure_points/upload_png/"
          accept="image"
          hint="Drop a PNG here, or click to choose"
          instantFileUpload={true}
          withPreview={false}
          payload={{ location_id: selectedLocationId }}
          callBackProcessing={handleSourceUpload}
        />
        <CadUploadDropbox
          auth={auth}
          url="/v1/status/measure_points/from_pdf/"
          accept="pdf"
          // Plan PDFs are often larger than the 5 MB default; one Lageplan per PDF.
          maxSizeMB={50}
          hint="Drop one or more PDFs here (a Lageplan each), or click to choose"
          instantFileUpload={true}
          withPreview={false}
          payload={{ location_id: selectedLocationId }}
          callBackProcessing={handleSourceUpload}
        />
      </div>
    </div>
  );

  const renderStepTwo = () => (
    <StepCard
      number={3}
      title="Lageplan"
      done={!!sourceMeta?.imageUrl}
      actions={
        lageplans.length > 0 && (
          <span className="lageplan-muted">
            {lageplans.length} plan(s) for this location
          </span>
        )
      }
    >
      {selectedLocationId === null ? (
        <Notice tone="warning">Select a location in step 1 first.</Notice>
      ) : (
        <div className="d-flex flex-column gap-3">
          {lageplans.length === 0 && !isProcessing && (
            <Notice>
              This location has no Lageplan yet - upload the first one below.
            </Notice>
          )}
          {lageplans.length > 0 && (
            <div className="lageplan-tiles">
              {lageplans.map((plan, index) => renderPlanTile(plan, index))}
              {!addingPlan && (
                <button type="button" onClick={() => setAddingPlan(true)} className="lageplan-tile lageplan-tile--add">
                  <span className="lageplan-tile-add-icon">
                    <PlusLg size={15} />
                  </span>
                  Add Lageplan
                </button>
              )}
            </div>
          )}
          {(addingPlan || lageplans.length === 0) && renderPlanUpload()}
          {selectedPlan && !selectedPlan.url && (
            <Notice tone="warning">
              The selected Lageplan has no file - pick another one or upload a
              new plan.
            </Notice>
          )}
        </div>
      )}
    </StepCard>
  );

  const renderManualSensors = () => (
    <div className="d-flex flex-column gap-3">
      <div className="lageplan-muted">
        Select a sensor, then click its position on the plan in step 5. Placed
        points can be dragged. Nothing is stored until you save.
      </div>

      {devices.length === 0 ? (
        <Notice tone="warning">
          No devices are connected to this location.
        </Notice>
      ) : (
        <div className="d-flex flex-wrap gap-2">
          {devices.map((device) => {
            const sensorIndex = placedSensors.findIndex(
              (sensor) => sensor.deviceId === device.id,
            );
            const order = sensorIndex + 1;
            const sensor = sensorIndex >= 0 ? placedSensors[sensorIndex] : null;
            const elsewhere =
              sensor !== null && !belongsTo(sensor.lageplanId, selectedPlanId);
            const active = device.id === activeDeviceId;
            return (
              <Button
                key={device.id}
                size="sm"
                variant={
                  active
                    ? 'primary'
                    : elsewhere
                      ? 'outline-info'
                      : order
                        ? 'outline-success'
                        : 'outline-secondary'
                }
                className="d-inline-flex align-items-center gap-1 lageplan-pill-button"
                title={[
                  device.hardware,
                  device.type,
                  device.raw_hash,
                  elsewhere && sensor
                    ? `placed on ${planNameOf(sensor.lageplanId)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onClick={() => setActiveDeviceId(active ? null : device.id)}
              >
                {order > 0 && (
                  <Badge
                    pill
                    bg={active ? 'light' : elsewhere ? 'info' : 'success'}
                    text={active ? 'dark' : undefined}
                  >
                    {order}
                  </Badge>
                )}
                <span className="font-monospace">{deviceLabel(device)}</span>
              </Button>
            );
          })}
        </div>
      )}

      <div className="d-flex flex-wrap align-items-center gap-2">
        <span className="lageplan-muted">
          {planSensors.length} on this plan · {placedSensors.length} /{' '}
          {devices.length} placed
          {placementDirty && ' · unsaved changes'}
        </span>
        {activeDevice && placedIds.has(activeDevice.id) && (
          <DeleteIconButton
            label={`Remove ${deviceLabel(activeDevice)} from the plan`}
            onClick={removeActiveSensor}
          />
        )}
        <div className="ms-auto d-flex gap-2">
          <PillButton
            variant="ghost"
            label="Discard changes"
            disabled={!placementDirty || isProcessing}
            onClick={discardPlacement}
          />
          <Button
            size="sm"
            variant="primary"
            className="lageplan-save-button"
            disabled={!placementDirty || isProcessing}
            onClick={() => void handleSaveManualSensors()}
          >
            Save manual sensors
          </Button>
        </div>
      </div>

      {placementDirty && replacedPointCount > 0 && (
        <Notice tone="warning">
          Saving replaces the {replacedPointCount} existing measure point(s)
          without a sensor (e.g. from a CAD import).
        </Notice>
      )}
      {!sourceMeta?.imageUrl && (
        <Notice>Select or add a Lageplan in step 3 to place the sensors.</Notice>
      )}
    </div>
  );

  // The devices the imported points are connected to (their measurements
  // come from them): each takes the sensors from..to, its pair 1 being the
  // first of them. Without a row the points stay without device.
  const renderDeviceRanges = () => {
    const rangeLabel = (text: string) => (
      <span className="lageplan-muted lageplan-muted--small">{text}</span>
    );
    return (
      <div className="d-flex flex-column gap-2">
        <div className="lageplan-muted lageplan-muted--small">
          {devices.length === 0
            ? 'No devices are connected to this location - the points are imported without device.'
            : 'The sensors imported in step 4 (CAD/JSON/TXT) are connected to these devices. Each device counts its pairs from 1: pair 1 is the first sensor of its range. Leave "to" empty for all sensors from "from" on. Placing sensors manually picks the device per sensor in step 4.'}
        </div>
        {deviceRanges.map((range, index) => (
          // Rows have no id of their own.
          <div key={index} className="d-flex flex-wrap align-items-center gap-2">
            <select
              aria-label="Device"
              className="form-select form-select-sm lageplan-range-field lageplan-range-field--device"
              value={range.deviceId ?? ''}
              onChange={(event) =>
                updateRange(index, {
                  deviceId: event.target.value ? Number(event.target.value) : null,
                })
              }
            >
              <option value="">choose a device</option>
              {devices.map((device) => {
                const connected = connectedCount(device.id);
                return (
                  <option key={device.id} value={device.id}>
                    {device.raw_hash}
                    {device.hardware ? ` · ${device.hardware}` : ''}
                    {connected ? ` · ${connected} point(s) now` : ''}
                  </option>
                );
              })}
            </select>
            {rangeLabel('sensors')}
            <input
              aria-label="First sensor"
              type="number"
              min={1}
              className="form-control form-control-sm lageplan-range-field lageplan-range-field--number"
              placeholder="1"
              value={range.from}
              onChange={(event) => updateRange(index, { from: event.target.value })}
            />
            {rangeLabel('to')}
            <input
              aria-label="Last sensor"
              type="number"
              min={1}
              className="form-control form-control-sm lageplan-range-field lageplan-range-field--number"
              placeholder="last"
              value={range.to}
              onChange={(event) => updateRange(index, { to: event.target.value })}
            />
            <DeleteIconButton
              label="Remove this device"
              onClick={() =>
                setDeviceRanges((current) => current.filter((_range, position) => position !== index))
              }
            />
          </div>
        ))}
        {devices.length > deviceRanges.length && (
          <div>
            <PillButton
              variant="ghost"
              label={deviceRanges.length ? 'Add another device' : 'Connect a device'}
              onClick={() =>
                setDeviceRanges((current) => {
                  // A new row continues after the last one's range.
                  const last = current[current.length - 1];
                  const next = last?.to.trim() ? String(Number(last.to) + 1) : current.length ? '' : '1';
                  const unused = devices.find((device) => !current.some((range) => range.deviceId === device.id));
                  return [...current, { deviceId: unused?.id ?? null, from: next, to: '' }];
                })
              }
            />
          </div>
        )}
        {deviceRangesProblem && <Notice tone="warning">{deviceRangesProblem}</Notice>}
      </div>
    );
  };

  const renderStepDevice = () => (
    <StepCard
      number={2}
      title="Device"
      done={usedRanges.length > 0 && !deviceRangesProblem}
      actions={
        selectedLocationId !== null && (
          <span className="lageplan-muted">
            {devices.length} device(s) at this location
          </span>
        )
      }
    >
      {selectedLocationId === null ? (
        <Notice tone="warning">Select a location in step 1 first.</Notice>
      ) : (
        renderDeviceRanges()
      )}
    </StepCard>
  );

  const renderStepThree = () => (
    <StepCard
      number={4}
      title="Measure points"
      done={measurePoints.length > 0 && !placementDirty}
      actions={
        selectedLocationId !== null && (
          <span className="d-flex align-items-center gap-2">
            <span className="lageplan-muted">
              {measurePoints.length} measure point(s) stored
            </span>
            {measurePoints.length > 0 && (
              <PillButton
                variant="ghost"
                label="Clear measure points"
                disabled={isProcessing}
                onClick={() => setConfirmAction({ kind: 'points' })}
              />
            )}
          </span>
        )
      }
    >
      {selectedLocationId === null ? (
        <Notice tone="warning">Select a location in step 1 first.</Notice>
      ) : (
        <div className="d-flex flex-column gap-3">
          <div className="lageplan-sources">
            <div>
              <SegmentedControl
                options={POINT_SOURCES}
                value={pointSource}
                onChange={(value) => setPointSource(value as PointSource)}
              />
            </div>
          </div>

          {pointSource !== 'manual' && deviceRangesProblem && (
            <Notice tone="warning">Fix the device ranges in step 2 before importing.</Notice>
          )}
          {/* No import while the device ranges don't fit (see the notice). */}
          {!deviceRangesProblem && pointSource === 'cad' && (
            <CadUploadDropbox
              auth={auth}
              url={`/v1/status/measure_points/upload_cad/`}
              accept="cad"
              hint="Drop a DWG/DXF file here, or click to choose"
              maxSizeMB={100}
              instantFileUpload={true}
              withPreview={false}
              payload={importPayload}
              callBackProcessing={handleCadUpload}
            />
          )}
          {!deviceRangesProblem && pointSource === 'json' && (
            <RedDropbox
              auth={auth}
              url={`/v1/status/measure_points/from_json/`}
              accept="json"
              hint="Drop a JSON file here, or click to choose"
              instantFileUpload={true}
              withPreview={false}
              payload={importPayload}
              callBackProcessing={handleJsonUpload}
            />
          )}
          {!deviceRangesProblem && pointSource === 'txt' && (
            <CadUploadDropbox
              auth={auth}
              url={`/v1/status/measure_points/upload_cad/`}
              accept="text"
              hint="Drop a TXT file here, or click to choose"
              instantFileUpload={true}
              withPreview={false}
              payload={importPayload}
              callBackProcessing={handleCadUpload}
            />
          )}
          {pointSource === 'manual' && renderManualSensors()}

          {pointSource !== 'manual' && lageplans.length > 1 && selectedPlanId !== null && (
            <Notice>
              Imported points go onto “{planNameOf(selectedPlanId)}” and replace
              the {pointsOnPlan(selectedPlanId)} point(s) on it - the points on
              the other plans stay.
            </Notice>
          )}
          {cadPayload && pointSource !== 'manual' && (
            <Notice tone="success">
              Import complete: {cadPayload.stored} points stored
              {cadPayload.lageplan_id != null ? ` on “${planNameOf(cadPayload.lageplan_id)}”` : ''}.
            </Notice>
          )}
          {cadPayload?.warning && pointSource !== 'manual' && (
            <Notice tone="warning">{cadPayload.warning}</Notice>
          )}
        </div>
      )}
    </StepCard>
  );

  const manualPlacement =
    pointSource === 'manual' && selectedLocationId !== null;

  const renderStepFour = () => (
    <StepCard number={5} title="Align and inspect">
      {!sourceMeta?.imageUrl ? (
        <Notice tone="warning">
          Select or add a Lageplan in step 3 before using the canvas editor.
        </Notice>
      ) : (
        <ImageCanvasStage
          // A different plan starts with its own view (zoom, tools).
          key={selectedPlanId ?? 'none'}
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
          lineSensors={planVisualization(selectedLocation?.project_type) === 'lines'}
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

  if (!permissionsLoading && !canEditDevices) {
    return (
      <div>
        <Notice tone="warning">
          You do not have permission to edit measure points.
        </Notice>
      </div>
    );
  }

  return (
    <div className="lageplan-wizard">
      <div className="lageplan-wizard-head">
        <div>
          <div className="lageplan-wizard-title">Lageplan wizard</div>
          <div className="lageplan-muted">
            Pick a location, choose or add a Lageplan, set the measure points
            and align them on the plan.
          </div>
        </div>
        {isProcessing && (
          <span className="d-flex align-items-center gap-2 lageplan-muted">
            <Spinner animation="border" size="sm" />
            Processing…
          </span>
        )}
        <div className="ms-auto">
          <PillButton
            variant="ghost"
            label="Reset"
            onClick={() => selectLocation(null)}
          />
        </div>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      {renderStepOne()}
      {renderStepDevice()}
      {renderStepTwo()}
      {renderStepThree()}
      {renderStepFour()}

      <ConfirmDialog
        show={confirmAction !== null}
        title={confirmAction?.kind === 'plan' ? 'Remove Lageplan?' : 'Clear measure points?'}
        message={
          confirmAction?.kind === 'plan'
            ? `“${planLabel(confirmAction.plan)}” is removed${
                pointsOnPlan(confirmAction.plan.id)
                  ? ` together with its ${pointsOnPlan(confirmAction.plan.id)} measure point(s)`
                  : ''
              }. This cannot be undone.`
            : `All ${measurePoints.length} measure point(s) of this location are removed - on every Lageplan. This cannot be undone.`
        }
        confirmLabel={confirmAction?.kind === 'plan' ? 'Remove' : 'Clear'}
        cancelLabel="Cancel"
        confirming={isProcessing}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          if (confirmAction?.kind === 'plan') {
            deletePlan(confirmAction.plan);
          } else if (confirmAction?.kind === 'points') {
            clearMeasurePoints();
          }
        }}
      />

      <ConfirmDialog
        show={renaming !== null}
        title="Rename Lageplan"
        message={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming) {
                renamePlan(renaming.plan, renaming.name);
              }
            }}
          >
            <label htmlFor="lageplan-rename-input" className="form-label lageplan-rename-label">
              Name (empty: the file name is shown)
            </label>
            <input
              id="lageplan-rename-input"
              className="form-control"
              autoFocus
              maxLength={255}
              value={renaming?.name ?? ''}
              placeholder={renaming?.plan.url?.split('/').pop() ?? ''}
              disabled={isProcessing}
              onChange={(event) =>
                setRenaming((current) => (current ? { ...current, name: event.target.value } : current))
              }
            />
          </form>
        }
        confirmLabel="Save"
        cancelLabel="Cancel"
        danger={false}
        confirming={isProcessing}
        onCancel={() => setRenaming(null)}
        onConfirm={() => {
          if (renaming) {
            renamePlan(renaming.plan, renaming.name);
          }
        }}
      />
    </div>
  );
};

export default LageplanWizardView;
