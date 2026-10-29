import React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Spinner,
} from 'react-bootstrap';
import { CheckCircleFill } from 'react-bootstrap-icons';
import RedDropbox from '../components/form/RedDropbox.tsx';
import LocationPicker, {
  type PickableLocation,
} from '../components/location/LocationPicker';
import ImageCanvasStage, {
  type PlacedSensor,
  type PlanScaleValues,
} from '../components/ui/ImageCanvasStage.tsx';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { getBackendUrl } from '../backendUrl';
import type { SensorHeatmapLageplanData } from '../components/device/sensorHeatmapTypes';
import { isLorawanProject } from './projectType';

type ImportedCad = {
  location_id: number;
  stored: number;
  points: Array<Record<string, unknown>>;
};

type ImportedSource = {
  fileName?: string;
  imageUrl?: string;
  type?: 'png' | 'pdf';
  offset_x?: number;
  offset_y?: number;
  scale_x?: number;
  scale_y?: number;
  flip_x?: boolean;
  flip_y?: boolean;
  reference_x?: number | null;
  reference_y?: number | null;
  meters_per_pixel?: number | null;
};

type WizardDevice = {
  id: number;
  mac?: string | null;
  hardware?: string | null;
  type?: string | null;
  raw_hash?: string | null;
};

type MeasurePointsResponse = {
  points?: Array<Record<string, unknown>>;
  // Backward compatible: primary lageplan data (for single active lageplan)
  lageplan_url?: string | null;
  offset_x?: number;
  offset_y?: number;
  scale_x?: number;
  scale_y?: number;
  flip_x?: boolean;
  flip_y?: boolean;
  reference_x?: number | null;
  reference_y?: number | null;
  meters_per_pixel?: number | null;
  // New: array of all lageplans with full metadata
  lageplans?: Array<SensorHeatmapLageplanData & { id: number }> | null;
  // ?with_devices=1: the devices a point can be assigned to.
  devices?: WizardDevice[];
};

/** A location of /v1/location/min/ (ProgeoLocationMinSerializer). The
 * measure_points endpoints address it by project id (their location_id). */
type WizardLocation = PickableLocation & {
  project_id: number;
  project_type?: number | null;
};

type PointSource = 'cad' | 'json' | 'txt' | 'manual';

const POINT_SOURCES: Array<{ value: PointSource; label: string }> = [
  { value: 'cad', label: 'CAD (DWG/DXF)' },
  { value: 'json', label: 'JSON' },
  { value: 'txt', label: 'TXT' },
  { value: 'manual', label: 'Manually set sensors' },
];

const getFileExt = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

/** Devices are shown by their MAC; without one by hardware name / hash. */
const deviceLabel = (device: WizardDevice) =>
  device.mac || device.hardware || device.raw_hash || `#${device.id}`;

/** The hand-placed sensors among stored points (in sensor order). */
const placedFromPoints = (
  points: Array<Record<string, unknown>>,
  devices: WizardDevice[],
): PlacedSensor[] =>
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
      };
    });

const requestReason = (requestError: unknown) =>
  (requestError as { response?: { data?: { reason?: string } } })?.response
    ?.data?.reason ?? (requestError as Error).message;

const StepCard = ({
  number,
  title,
  done,
  children,
}: {
  number: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) => (
  <Card className="shadow-sm">
    <Card.Header className="d-flex align-items-center gap-2 py-2">
      <Badge pill bg={done ? 'success' : 'secondary'}>
        {number}
      </Badge>
      <strong>{title}</strong>
      {done && <CheckCircleFill className="text-success ms-auto" />}
    </Card.Header>
    <Card.Body className="py-3">{children}</Card.Body>
  </Card>
);

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
  const [sourceMeta, setSourceMeta] = useState<ImportedSource | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  // Bumped to reload the measure points (e.g. after a JSON import).
  const [reloadKey, setReloadKey] = useState(0);

  // Step 2, "Manually set sensors": the location's devices and the points
  // placed on the plan - stored only with "Save manual sensors".
  const [pointSource, setPointSource] = useState<PointSource>('cad');
  const [devices, setDevices] = useState<WizardDevice[]>([]);
  const [placedSensors, setPlacedSensors] = useState<PlacedSensor[]>([]);
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
    setSourceMeta(null);
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
          const placed = placedFromPoints(points, loadedDevices);
          setMeasurePoints(points);
          setDevices(loadedDevices);
          setPlacedSensors(placed);
          setActiveDeviceId(null);
          setPlacementDirty(false);
          if (placed.length) {
            setPointSource('manual');
          }

          if (data.lageplan_url) {
            const fileName =
              data.lageplan_url.split('/').pop() || 'lageplan.png';
            setSourceMeta({
              fileName,
              imageUrl: getBackendUrl(data.lageplan_url),
              type: 'png',
              offset_x: data.offset_x ?? 0,
              offset_y: data.offset_y ?? 0,
              scale_x: data.scale_x ?? 1,
              scale_y: data.scale_y ?? 1,
              flip_x: data.flip_x ?? false,
              flip_y: data.flip_y ?? false,
              reference_x: data.reference_x ?? null,
              reference_y: data.reference_y ?? null,
              meters_per_pixel: data.meters_per_pixel ?? null,
            });
          } else {
            setSourceMeta(null);
          }
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
    if (selectedLocationId === null) {
      setError('Select a location before storing the alignment.');
      return;
    }

    setIsProcessing(true);
    setError('');
    await axiosConfig.perform_post(
      auth,
      '/v1/location/update/',
      {
        location_id: selectedLocationId,
        offset_x: values.offsetX,
        offset_y: values.offsetY,
        scale_x: values.scaleX,
        scale_y: values.scaleY,
        flip_y: values.flipY,
      },
      () => setIsProcessing(false),
      (saveError) => {
        setError(`Could not store alignment: ${(saveError as Error).message}`);
        setIsProcessing(false);
      },
    );
  };

  // RedDropbox (instantFileUpload) passes the upload response, which carries
  // the stored Lageplan - see StatusViewSet.upload_measure_points_from_png.
  // Metric scale of the active Lageplan (reference point + meters per pixel).
  const handleSaveScale = async (values: PlanScaleValues) => {
    if (selectedLocationId === null) {
      setError('Select a location before storing the scale.');
      return;
    }

    setIsProcessing(true);
    setError('');
    await axiosConfig.perform_post(
      auth,
      '/v1/location/update_scale/',
      { location_id: selectedLocationId, ...values },
      () => setIsProcessing(false),
      (saveError) => {
        setError(`Could not store the scale: ${(saveError as Error).message}`);
        setIsProcessing(false);
      },
    );
  };

  const handleSourceUpload = (response: Record<string, unknown>) => {
    const lageplanUrl =
      typeof response?.lageplan_url === 'string' ? response.lageplan_url : '';
    if (!lageplanUrl) {
      setError('The upload response did not contain the stored Lageplan.');
      return;
    }

    const fileName = lageplanUrl.split('/').pop() || 'lageplan.png';
    setError('');
    // A freshly stored Lageplan starts with the default alignment.
    setSourceMeta({
      fileName,
      imageUrl: getBackendUrl(lageplanUrl),
      type: getFileExt(fileName) === 'pdf' ? 'pdf' : 'png',
      offset_x: 0,
      offset_y: 0,
      scale_x: 1,
      scale_y: 1,
      flip_x: false,
      flip_y: false,
    });
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

  const placeActiveSensor = (nx: number, ny: number) => {
    if (!activeDevice) {
      return;
    }
    const placed: PlacedSensor = {
      deviceId: activeDevice.id,
      label: deviceLabel(activeDevice),
      nx,
      ny,
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
        sensor.deviceId === deviceId ? { ...sensor, nx, ny } : sensor,
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
    <StepCard number={1} title="Select location" done={!!selectedLocation}>
      <LocationPicker
        id="lageplan-location-picker"
        locations={locations}
        value={selectedLocationId}
        valueKey="project_id"
        onChange={selectLocation}
        loading={locationLoading}
      />

      {!locations.length && !locationLoading && (
        <Alert variant="warning" className="mt-3 mb-0">
          No locations are available yet.
        </Alert>
      )}
    </StepCard>
  );

  const renderManualSensors = () => (
    <div className="d-flex flex-column gap-2">
      <p className="small text-muted mb-0">
        Select a sensor, then click its position on the plan in step 4. Placed
        points can be dragged. Nothing is stored until you save.
      </p>

      {devices.length === 0 ? (
        <Alert variant="warning" className="mb-0 py-2">
          No devices are connected to this location.
        </Alert>
      ) : (
        <div className="d-flex flex-wrap gap-2">
          {devices.map((device) => {
            const order =
              placedSensors.findIndex(
                (sensor) => sensor.deviceId === device.id,
              ) + 1;
            const active = device.id === activeDeviceId;
            return (
              <Button
                key={device.id}
                size="sm"
                variant={
                  active
                    ? 'primary'
                    : order
                      ? 'outline-success'
                      : 'outline-secondary'
                }
                className="d-inline-flex align-items-center gap-1"
                title={[device.hardware, device.type, device.raw_hash]
                  .filter(Boolean)
                  .join(' · ')}
                onClick={() => setActiveDeviceId(active ? null : device.id)}
              >
                {order > 0 && (
                  <Badge
                    bg={active ? 'light' : 'success'}
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
        <span className="small text-muted">
          {placedSensors.length} / {devices.length} placed
          {placementDirty && ' · unsaved changes'}
        </span>
        {activeDevice && placedIds.has(activeDevice.id) && (
          <Button
            size="sm"
            variant="outline-danger"
            onClick={removeActiveSensor}
          >
            Remove {deviceLabel(activeDevice)}
          </Button>
        )}
        <div className="ms-auto d-flex gap-2">
          <Button
            size="sm"
            variant="outline-secondary"
            disabled={!placementDirty || isProcessing}
            onClick={discardPlacement}
          >
            Discard changes
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!placementDirty || isProcessing}
            onClick={() => void handleSaveManualSensors()}
          >
            Save manual sensors
          </Button>
        </div>
      </div>

      {placementDirty && replacedPointCount > 0 && (
        <Alert variant="warning" className="mb-0 py-2 small">
          Saving replaces the {replacedPointCount} existing measure point(s)
          without a sensor (e.g. from a CAD import).
        </Alert>
      )}
      {!sourceMeta?.imageUrl && (
        <Alert variant="info" className="mb-0 py-2 small">
          Upload the plan image in step 3 to place the sensors.
        </Alert>
      )}
    </div>
  );

  const renderStepTwo = () => (
    <StepCard
      number={2}
      title="Measure points"
      done={measurePoints.length > 0 && !placementDirty}
    >
      {selectedLocationId === null ? (
        <Alert variant="warning" className="mb-0 py-2">
          Select a location in step 1 first.
        </Alert>
      ) : (
        <div className="d-flex flex-column gap-3">
          <div className="d-flex flex-wrap align-items-center gap-3">
            <div style={{ maxWidth: 560 }} className="flex-grow-1">
              <SegmentedControl
                options={POINT_SOURCES}
                value={pointSource}
                onChange={(value) => setPointSource(value as PointSource)}
              />
            </div>
            <span className="small text-muted">
              {measurePoints.length} measure point(s) stored
            </span>
          </div>

          {pointSource === 'cad' && (
            <RedDropbox
              auth={auth}
              url={`/v1/status/measure_points/upload_cad/`}
              accept="cad"
              hint="Upload DWG/DXF"
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
              hint="Upload JSON"
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
              hint="Upload TXT"
              instantFileUpload={true}
              withPreview={false}
              payload={{ location_id: selectedLocationId }}
              callBackProcessing={handleCadUpload}
            />
          )}
          {pointSource === 'manual' && renderManualSensors()}

          {cadPayload && pointSource !== 'manual' && (
            <Alert variant="success" className="mb-0 py-2">
              Import complete: {cadPayload.stored} points stored.
            </Alert>
          )}
        </div>
      )}
    </StepCard>
  );

  const renderStepThree = () => (
    <StepCard
      number={3}
      title="Upload plan image"
      done={!!sourceMeta?.imageUrl}
    >
      <p className="small text-muted mb-2">
        Upload a PNG or PDF rendering of the plan. PDF files are processed
        through the export pipeline.
        {sourceMeta?.fileName && (
          <>
            {' '}
            Current: <strong>{sourceMeta.fileName}</strong>
          </>
        )}
      </p>
      <div className="row g-2">
        <div className="col-md-6">
          <RedDropbox
            auth={auth}
            url="/v1/status/measure_points/upload_png/"
            accept="image"
            hint="Upload PNG"
            instantFileUpload={true}
            withPreview={false}
            payload={{ location_id: selectedLocationId }}
            callBackProcessing={handleSourceUpload}
          />
        </div>
        <div className="col-md-6">
          <RedDropbox
            auth={auth}
            url="/v1/status/measure_points/from_pdf/"
            accept="pdf"
            hint="Upload PDF"
            instantFileUpload={true}
            withPreview={false}
            payload={{ location_id: selectedLocationId ?? 0 }}
            callBackProcessing={handleFromPdfUpload}
          />
        </div>
      </div>
    </StepCard>
  );

  const manualPlacement =
    pointSource === 'manual' && selectedLocationId !== null;

  const renderStepFour = () => (
    <StepCard number={4} title="Align and inspect the plan">
      {!sourceMeta?.imageUrl ? (
        <Alert variant="warning" className="mb-0 py-2">
          Upload a PNG or PDF in step 3 before using the canvas editor.
        </Alert>
      ) : (
        <ImageCanvasStage
          sourceMeta={sourceMeta}
          imageUrl={sourceMeta.imageUrl}
          title={
            manualPlacement
              ? `${placedSensors.length} sensor(s) placed`
              : `${measurePoints.length} measure point(s)`
          }
          fileName={sourceMeta.fileName}
          locationId={selectedLocationId ?? undefined}
          measurePoints={measurePoints}
          withSliders={canEditLocation}
          onSaveSliders={canEditLocation ? handleSaveSliders : undefined}
          onSaveScale={canEditLocation ? handleSaveScale : undefined}
          placement={
            manualPlacement
              ? {
                  sensors: placedSensors,
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
      <Container className="py-4">
        <Alert variant="warning" className="mb-0">
          You do not have permission to edit measure points.
        </Alert>
      </Container>
    );
  }

  return (
    <Container fluid="xl" className="py-3 d-flex flex-column gap-3">
      <div className="d-flex align-items-center gap-3">
        <h4 className="mb-0">Lageplan setup wizard</h4>
        {isProcessing && (
          <span className="d-flex align-items-center gap-2 small text-muted">
            <Spinner animation="border" size="sm" />
            Processing…
          </span>
        )}
        <Button
          variant="outline-secondary"
          size="sm"
          className="ms-auto"
          onClick={() => selectLocation(null)}
        >
          Reset
        </Button>
      </div>

      {error && (
        <Alert variant="danger" className="mb-0">
          {error}
        </Alert>
      )}

      {renderStepOne()}
      {renderStepTwo()}
      {renderStepThree()}
      {renderStepFour()}
    </Container>
  );
};

export default LageplanWizardView;
