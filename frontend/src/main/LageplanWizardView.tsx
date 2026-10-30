import React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Spinner } from 'react-bootstrap';
import { CheckLg, FileEarmarkPdf, PlusLg } from 'react-bootstrap-icons';
import RedDropbox from '../components/form/RedDropbox.tsx';
import LocationPicker, {
  type PickableLocation,
} from '../components/location/LocationPicker';
import ImageCanvasStage, {
  type PlacedSensor,
  type PlanScaleValues,
} from '../components/ui/ImageCanvasStage.tsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { getBackendUrl } from '../backendUrl';
import type { SensorHeatmapLageplanData } from '../components/device/sensorHeatmapTypes';
import { isLorawanProject } from './projectType';
import { formatDate } from './dateFormat';

type ImportedCad = {
  location_id: number;
  stored: number;
  points: Array<Record<string, unknown>>;
};

type WizardDevice = {
  id: number;
  mac?: string | null;
  hardware?: string | null;
  type?: string | null;
  raw_hash?: string | null;
};

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

const MUTED = '#8B8383';

const getFileExt = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/** Devices are shown by their MAC; without one by hardware name / hash. */
const deviceLabel = (device: WizardDevice) =>
  device.mac || device.hardware || device.raw_hash || `#${device.id}`;

const planLabel = (plan: WizardLageplan) =>
  plan.name || plan.url?.split('/').pop() || `Lageplan #${plan.id}`;

/** Whether the plan's points were moved/scaled away from the defaults. */
const isAligned = (plan: WizardLageplan) =>
  Boolean(plan.offset_x || plan.offset_y || plan.flip_y) ||
  (plan.scale_x ?? 1) !== 1 ||
  (plan.scale_y ?? 1) !== 1;

/** The hand-placed sensors among stored points (in sensor order). */
const placedFromPoints = (
  points: Array<Record<string, unknown>>,
  devices: WizardDevice[],
): WizardSensor[] =>
  points
    .filter((point) => point.device != null)
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

const requestReason = (requestError: unknown) =>
  (requestError as { response?: { data?: { reason?: string } } })?.response
    ?.data?.reason ?? (requestError as Error).message;

// -- building blocks ----------------------------------------------------------

const NOTICE_TONES = {
  info: { background: 'var(--progeo-surface)', color: '#6E6868' },
  warning: { background: '#FBF3DE', color: '#9A7208' },
  danger: { background: '#FBE9E3', color: '#C44D26' },
  success: { background: '#EBF4E3', color: '#3F7A1C' },
} as const;

const Notice = ({
  tone = 'info',
  children,
}: {
  tone?: keyof typeof NOTICE_TONES;
  children: React.ReactNode;
}) => (
  <div
    style={{
      ...NOTICE_TONES[tone],
      borderRadius: 12,
      padding: '11px 15px',
      fontSize: 12.5,
      lineHeight: 1.5,
    }}
  >
    {children}
  </div>
);

const Chip = ({
  children,
  color = '#6E6868',
  background = 'var(--progeo-track-soft)',
}: {
  children: React.ReactNode;
  color?: string;
  background?: string;
}) => (
  <span
    style={{
      fontSize: 11,
      fontWeight: 600,
      color,
      background,
      borderRadius: 'var(--progeo-radius-pill)',
      padding: '2px 8px',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
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
      <span style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12.5,
            fontWeight: 600,
            background: done ? 'var(--progeo-contrast-green)' : 'var(--progeo-track)',
            color: done ? '#fff' : 'var(--progeo-blue)',
          }}
        >
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
    <div
      style={{
        aspectRatio: '4 / 3',
        borderRadius: 10,
        background: 'var(--progeo-track-soft)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        color: MUTED,
        fontSize: 12,
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
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

const tileStyle = (selected: boolean): React.CSSProperties => ({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 9,
  padding: 8,
  border: 'none',
  borderRadius: 14,
  background: 'var(--progeo-surface)',
  boxShadow: selected
    ? '0 0 0 2px var(--progeo-blue)'
    : 'inset 0 0 0 1px rgba(11, 54, 89, 0.07)',
  textAlign: 'left',
  fontFamily: 'inherit',
  color: 'var(--progeo-blue)',
  cursor: 'pointer',
  minWidth: 0,
});

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

  // Step 2: the location's Lageplans (active ones first, as the backend
  // orders them) and the one the next steps work on.
  const [lageplans, setLageplans] = useState<WizardLageplan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [addingPlan, setAddingPlan] = useState(false);

  // Step 3, "Manually set sensors": the location's devices and the points
  // placed on the plans - stored only with "Save manual sensors".
  const [pointSource, setPointSource] = useState<PointSource>('cad');
  const [devices, setDevices] = useState<WizardDevice[]>([]);
  const [placedSensors, setPlacedSensors] = useState<WizardSensor[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<number | null>(null);
  const [placementDirty, setPlacementDirty] = useState(false);

  // Everything below step 1 belongs to the selected location.
  const selectLocation = (next: WizardLocation | null) => {
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
          setDevices(loadedDevices);
          setPlacedSensors(placed);
          setActiveDeviceId(null);
          setPlacementDirty(false);
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
            flip_y: selectedPlan.flip_y ?? false,
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

  const handleJsonUpload = () => {
    // The JSON import answers with the uploaded file, not the stored points.
    setError('');
    setReloadKey((key) => key + 1);
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
  };

  const handleFromPdfUpload = async (_payload: FormData) => {};

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
      },
      (saveError) => {
        setError(`Could not store the scale: ${requestReason(saveError)}`);
        setIsProcessing(false);
      },
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
  };

  // -- manual placement -------------------------------------------------------

  const placedIds = useMemo(
    () => new Set(placedSensors.map((sensor) => sensor.deviceId)),
    [placedSensors],
  );
  const activeDevice =
    devices.find((device) => device.id === activeDeviceId) ?? null;
  // Saving replaces every point of the location, also those without device.
  const replacedPointCount = measurePoints.filter(
    (point) => point.device == null,
  ).length;
  // What the canvas shows: the points / sensors of the picked plan.
  const planPoints = measurePoints.filter((point) =>
    belongsTo(point.lageplan, selectedPlanId),
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
      },
      (saveError) => {
        setError(`Could not store the sensors: ${requestReason(saveError)}`);
        setIsProcessing(false);
      },
    );
  };

  // -- steps ------------------------------------------------------------------

  const renderStepOne = () => (
    <StepCard number={1} title="Location" done={!!selectedLocation}>
      <div style={{ maxWidth: 560 }}>
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
        <div style={{ marginTop: 12 }}>
          <Notice tone="warning">No locations are available yet.</Notice>
        </div>
      )}
    </StepCard>
  );

  const renderPlanTile = (plan: WizardLageplan) => {
    const selected = plan.id === selectedPlanId;
    const pointCount = measurePoints.filter((point) =>
      belongsTo(point.lageplan, plan.id),
    ).length;
    const updated = plan.last_updated ? new Date(plan.last_updated) : null;
    return (
      <button
        key={plan.id}
        type="button"
        onClick={() => selectPlan(plan.id)}
        aria-pressed={selected}
        style={tileStyle(selected)}
      >
        <LageplanThumb key={plan.url ?? ''} url={plan.url} />
        {selected && (
          <span
            style={{
              position: 'absolute',
              top: 14,
              right: 14,
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: 'var(--progeo-blue)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CheckLg size={13} />
          </span>
        )}
        <div style={{ padding: '0 4px 4px', minWidth: 0 }}>
          <div
            title={planLabel(plan)}
            style={{
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {planLabel(plan)}
          </div>
          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>
            #{plan.id}
            {updated && !Number.isNaN(updated.getTime())
              ? ` · ${formatDate(updated, 'date')}`
              : ''}
            {` · ${pointCount} point(s)`}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
            {plan.is_active ? (
              <Chip color="#3F7A1C" background="#EBF4E3">
                Active
              </Chip>
            ) : (
              <Chip>Inactive</Chip>
            )}
            {isAligned(plan) && <Chip>Aligned</Chip>}
            {plan.meters_per_pixel ? <Chip>Scale set</Chip> : null}
          </div>
        </div>
      </button>
    );
  };

  const renderPlanUpload = () => (
    <div
      style={{
        background: 'var(--progeo-surface)',
        borderRadius: 13,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div className="d-flex align-items-start gap-2">
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>Add a Lageplan</div>
          <div style={{ fontSize: 12, color: MUTED }}>
            Upload a PNG rendering of the plan - it is added to the existing
            ones and selected. PDF files are processed through the export
            pipeline.
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
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
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
        <RedDropbox
          auth={auth}
          url="/v1/status/measure_points/from_pdf/"
          accept="pdf"
          hint="Drop a PDF here, or click to choose"
          instantFileUpload={true}
          withPreview={false}
          payload={{ location_id: selectedLocationId ?? 0 }}
          callBackProcessing={handleFromPdfUpload}
        />
      </div>
    </div>
  );

  const renderStepTwo = () => (
    <StepCard
      number={2}
      title="Lageplan"
      done={!!sourceMeta?.imageUrl}
      actions={
        lageplans.length > 0 && (
          <span style={{ fontSize: 12.5, color: MUTED }}>
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
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                gap: 12,
              }}
            >
              {lageplans.map(renderPlanTile)}
              {!addingPlan && (
                <button
                  type="button"
                  onClick={() => setAddingPlan(true)}
                  style={{
                    ...tileStyle(false),
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 150,
                    background: 'transparent',
                    boxShadow: 'none',
                    border: '1.5px dashed var(--progeo-warm-gray-3)',
                    color: MUTED,
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  <span
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: '50%',
                      background: 'var(--progeo-track)',
                      color: 'var(--progeo-blue)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
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
      <div style={{ fontSize: 12.5, color: MUTED }}>
        Select a sensor, then click its position on the plan in step 4. Placed
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
                className="d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 'var(--progeo-radius-pill)' }}
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
        <span style={{ fontSize: 12.5, color: MUTED }}>
          {planSensors.length} on this plan · {placedSensors.length} /{' '}
          {devices.length} placed
          {placementDirty && ' · unsaved changes'}
        </span>
        {activeDevice && placedIds.has(activeDevice.id) && (
          <Button
            size="sm"
            variant="outline-danger"
            style={{ borderRadius: 'var(--progeo-radius-pill)' }}
            onClick={removeActiveSensor}
          >
            Remove {deviceLabel(activeDevice)}
          </Button>
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
            style={{
              borderRadius: 'var(--progeo-radius-pill)',
              height: 32,
              padding: '0 16px',
            }}
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
        <Notice>Select or add a Lageplan in step 2 to place the sensors.</Notice>
      )}
    </div>
  );

  const renderStepThree = () => (
    <StepCard
      number={3}
      title="Measure points"
      done={measurePoints.length > 0 && !placementDirty}
      actions={
        selectedLocationId !== null && (
          <span style={{ fontSize: 12.5, color: MUTED }}>
            {measurePoints.length} measure point(s) stored
          </span>
        )
      }
    >
      {selectedLocationId === null ? (
        <Notice tone="warning">Select a location in step 1 first.</Notice>
      ) : (
        <div className="d-flex flex-column gap-3">
          <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
            <div style={{ display: 'inline-flex' }}>
              <SegmentedControl
                options={POINT_SOURCES}
                value={pointSource}
                onChange={(value) => setPointSource(value as PointSource)}
              />
            </div>
          </div>

          {pointSource === 'cad' && (
            <RedDropbox
              auth={auth}
              url={`/v1/status/measure_points/upload_cad/`}
              accept="cad"
              hint="Drop a DWG/DXF file here, or click to choose"
              instantFileUpload={true}
              withPreview={false}
              payload={{ location_id: selectedLocationId }}
              callBackProcessing={handleCadUpload}
            />
          )}
          {pointSource === 'json' && (
            <RedDropbox
              auth={auth}
              url={`/v1/status/measure_points/from_json/`}
              accept="json"
              hint="Drop a JSON file here, or click to choose"
              instantFileUpload={true}
              withPreview={false}
              payload={{ location_id: selectedLocationId }}
              callBackProcessing={handleJsonUpload}
            />
          )}
          {pointSource === 'txt' && (
            <RedDropbox
              auth={auth}
              url={`/v1/status/measure_points/upload_cad/`}
              accept="text"
              hint="Drop a TXT file here, or click to choose"
              instantFileUpload={true}
              withPreview={false}
              payload={{ location_id: selectedLocationId }}
              callBackProcessing={handleCadUpload}
            />
          )}
          {pointSource === 'manual' && renderManualSensors()}

          {pointSource !== 'manual' &&
            lageplans.length > 1 &&
            selectedPlanId !== mainPlanId && (
              <Notice>
                Imported points are not tied to a Lageplan - they show on the
                main plan “{planNameOf(mainPlanId)}”.
              </Notice>
            )}
          {cadPayload && pointSource !== 'manual' && (
            <Notice tone="success">
              Import complete: {cadPayload.stored} points stored.
            </Notice>
          )}
        </div>
      )}
    </StepCard>
  );

  const manualPlacement =
    pointSource === 'manual' && selectedLocationId !== null;

  const renderStepFour = () => (
    <StepCard number={4} title="Align and inspect">
      {!sourceMeta?.imageUrl ? (
        <Notice tone="warning">
          Select or add a Lageplan in step 2 before using the canvas editor.
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
              : `${planPoints.length} measure point(s) on this plan`
          }
          fileName={sourceMeta.fileName}
          locationId={selectedLocationId ?? undefined}
          lageplanId={selectedPlanId ?? undefined}
          measurePoints={planPoints}
          withSliders={canEditLocation}
          onSaveSliders={canEditLocation ? handleSaveSliders : undefined}
          onSaveScale={canEditLocation ? handleSaveScale : undefined}
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
      <div style={{ maxWidth: 1180 }}>
        <Notice tone="warning">
          You do not have permission to edit measure points.
        </Notice>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        maxWidth: 1180,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: '0 4px',
        }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>Lageplan wizard</div>
          <div style={{ fontSize: 12.5, color: MUTED }}>
            Pick a location, choose or add a Lageplan, set the measure points
            and align them on the plan.
          </div>
        </div>
        {isProcessing && (
          <span
            className="d-flex align-items-center gap-2"
            style={{ fontSize: 12.5, color: MUTED }}
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
          />
        </div>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      {renderStepOne()}
      {renderStepTwo()}
      {renderStepThree()}
      {renderStepFour()}
    </div>
  );
};

export default LageplanWizardView;
