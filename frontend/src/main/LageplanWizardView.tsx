import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Container,
  ProgressBar,
  Row,
  Spinner,
} from 'react-bootstrap';
import { Typeahead } from 'react-bootstrap-typeahead';
import RedDropbox from '../components/form/RedDropbox.tsx';
import ImageCanvasStage from '../components/ui/ImageCanvasStage.tsx';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';

type WizardStep = 1 | 2 | 3 | 4;

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
};

type MeasurePointsResponse = {
  points?: Array<Record<string, unknown>>;
  lageplan?: string | null;
  offset_x?: number;
  offset_y?: number;
  scale_x?: number;
  scale_y?: number;
  flip_x?: boolean;
  flip_y?: boolean;
};

type DeviceOption = {
  id: number;
  label: string;
  raw_hash?: string;
  hardware?: string;
  device_ip?: string;
};

const getFileExt = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

const LageplanWizardView = () => {
  const auth = useAuth();
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(
    null,
  );
  const [locations, setLocations] = useState<DeviceOption[]>([]);
  const [locationLoading, setLocationLoading] = useState(false);
  const [cadFileName, setCadFileName] = useState('');
  const [cadPayload, setCadPayload] = useState<ImportedCad | null>(null);
  const [measurePoints, setMeasurePoints] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [sourceFileName, setSourceFileName] = useState('');
  const [sourceMeta, setSourceMeta] = useState<ImportedSource | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');

  const selectedLocation = useMemo(
    () => locations.find((loc) => loc.id === selectedLocationId) ?? null,
    [locations, selectedLocationId],
  );

  const getBackendUrl = (path: string) => {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    const backendUrl =
      import.meta.env.VITE_BACKEND_URL || window.location.origin;
    return `${backendUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  };

  const progress = useMemo(() => {
    if (step === 1) {
      return 25;
    }
    if (step === 2) {
      return 50;
    }
    if (step === 3) {
      return 75;
    }
    return 100;
  }, [step]);

  useEffect(() => {
    const fetchDevices = async () => {
      setLocationLoading(true);
      try {
        await axiosConfig.perform_get(
          auth,
          '/v1/location/',
          (response) => {
            const list = Array.isArray(response?.data) ? response.data : [];

            const mapped = list
              .map((loc) => ({
                id: Number(loc?.project_id),
                label: `${loc?.project_id}`,
              }))
              .filter((loc) => Number.isFinite(loc.id) && loc.id > 0);

            setLocations(mapped);
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

    void fetchDevices();
  }, [auth]);

  useEffect(() => {
    if (selectedLocationId === null) {
      setMeasurePoints([]);
      setSourceMeta(null);
      return;
    }

    let cancelled = false;
    setIsProcessing(true);
    setError('');

    void axiosConfig
      .perform_get(
        auth,
        `/v1/status/measure_points/?location_id=${selectedLocationId}&with_lageplan=true`,
        (response) => {
          if (cancelled) {
            return;
          }

          const data = (response?.data ?? {}) as MeasurePointsResponse;
          const points = Array.isArray(data.points) ? data.points : [];
          setMeasurePoints(points);

          if (data.lageplan) {
            console.log('Lageplan URL from backend:', data.lageplan);
            const fileName = data.lageplan.split('/').pop() || 'lageplan.png';
            setSourceFileName(fileName);
            setSourceMeta({
              fileName,
              imageUrl: getBackendUrl(data.lageplan),
              type: 'png',
              offset_x: data.offset_x ?? 0,
              offset_y: data.offset_y ?? 0,
              scale_x: data.scale_x ?? 1,
              scale_y: data.scale_y ?? 1,
              flip_x: data.flip_x ?? false,
            });
            setStep(4);
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
  }, [auth, selectedLocationId]);

  const handleJsonUpload = (response: Record<string, unknown>) => {
    const data = response.data;
    console.log('JSON upload response data:', data);
  };

  const handleCadUpload = (response: Record<string, unknown>) => {
    const valid = response as ImportedCad;
    if (!valid || !Array.isArray(valid.points)) {
      setError('The CAD upload did not return valid measure points.');
      return;
    }

    setCadPayload(valid);
    setMeasurePoints(valid.points);
    setCadFileName(
      valid.location_id ? `device_${valid.location_id}.dwg` : cadFileName,
    );
    setError('');
    setStep(3);
  };

  const handleFromPdfUpload = async (payload: FormData) => {};

  const handleSaveSliders = async (values: {
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
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
      },
      () => setIsProcessing(false),
      (saveError) => {
        setError(`Could not store alignment: ${(saveError as Error).message}`);
        setIsProcessing(false);
      },
    );
  };

  const handleSourceUpload = async (payload: FormData) => {
    const file = payload.get('files0');
    if (!(file instanceof File)) {
      setError('No source file found in the upload payload.');
      return;
    }

    const ext = getFileExt(file.name);
    const isPng = ext === 'png';

    if (!isPng) {
      setError('Only PNG files are supported in step two.');
      return;
    }

    setIsProcessing(true);
    setError('');
    setSourceFileName(file.name);

    try {
      const objectUrl = URL.createObjectURL(file);
      const nextMeta: ImportedSource = {
        fileName: file.name,
        imageUrl: objectUrl,
        type: 'png',
      };
      setSourceMeta(nextMeta);
      setStep(4);
    } catch (exc) {
      setError(
        `Could not prepare the uploaded file: ${(exc as Error).message}`,
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const renderStepOne = () => (
    <Card className="shadow-sm">
      <Card.Header>1. Select Location</Card.Header>
      <Card.Body className="m-2">
        <p className="text-muted mb-3">
          Choose the location that will receive the measure points and layout
          data.
        </p>

        <Typeahead
          id="lageplan-device-typeahead"
          options={locations}
          labelKey="label"
          selected={selectedLocation ? [selectedLocation] : []}
          onChange={(selection) => {
            const next = selection[0] as LocationOption | undefined;
            setSelectedLocationId(next ? next.id : null);
            setError('');
          }}
          placeholder={
            locationLoading ? 'Loading locations…' : 'Select a location…'
          }
          disabled={locationLoading || !locations.length}
          clearButton
          singleSelect
        />

        {!locations.length && !locationLoading && (
          <Alert variant="warning" className="mt-3 mb-0">
            No locations are available yet.
          </Alert>
        )}

        {selectedLocation && (
          <Alert variant="success" className="mt-3 mb-0">
            Selected location: {selectedLocation.label}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );

  const renderStepTwo = () => (
    <Card className="shadow-sm">
      <Card.Header>2. Upload CAD reference</Card.Header>
      <Card.Body className="m-2">
        <p className="text-muted mb-3">
          Upload the DWG/DXF file that defines the measure points for the
          layout.
        </p>
        {selectedLocationId === null ? (
          <Alert variant="warning" className="mb-0">
            Select a device in step one before uploading the CAD file.
          </Alert>
        ) : (
          <>
            <RedDropbox
              auth={auth}
              url={`/v1/status/measure_points/upload_cad/`}
              accept="cad"
              hint="Upload DWG"
              instantFileUpload={true}
              withPreview={false}
              payload={{ location_id: selectedLocationId }}
              callBackProcessing={handleCadUpload}
            />
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
          </>
        )}
        {cadPayload && (
          <Alert variant="success" className="mt-3 mb-0">
            CAD import complete: {cadPayload.stored} points stored.
          </Alert>
        )}
      </Card.Body>
    </Card>
  );

  const renderStepThree = () => (
    <Card className="shadow-sm">
      <Card.Header>3. Upload source image</Card.Header>
      <Card.Body className="m-2">
        <p className="text-muted mb-3">
          Upload a PNG or PDF rendering to align the layout. PDF files are
          processed through the export pipeline.
        </p>

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

        <div className="mt-3">
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

        {sourceMeta && (
          <Alert variant="info" className="mt-3 mb-0">
            Ready: {sourceMeta.fileName}
          </Alert>
        )}
      </Card.Body>
    </Card>
  );

  const renderStepFour = () => (
    <Card className="shadow-sm">
      <Card.Header>4. Align and inspect the source</Card.Header>
      <Card.Body className="m-2">
        {measurePoints.length > 0 && (
          <Alert variant="success" className="mb-3">
            {measurePoints.length} measure points loaded for this device.
          </Alert>
        )}
        {!sourceMeta?.imageUrl ? (
          <Alert variant="warning" className="mb-0">
            Upload a PNG or PDF in step three before using the canvas editor.
          </Alert>
        ) : (
          <ImageCanvasStage
            sourceMeta={sourceMeta}
            imageUrl={sourceMeta.imageUrl}
            title={sourceMeta.fileName || 'Imported source'}
            fileName={sourceMeta.fileName}
            locationId={selectedLocationId}
            measurePoints={measurePoints}
            withSliders
            onSaveSliders={handleSaveSliders}
          />
        )}
      </Card.Body>
    </Card>
  );

  return (
    <Container className="py-4">
      <Row className="mb-4">
        <Col>
          <Card>
            <Card.Body>
              <div className="d-flex justify-content-between align-items-center mb-2">
                <h4 className="mb-0">Lageplan setup wizard</h4>
                <Button
                  variant="outline-secondary"
                  size="sm"
                  onClick={() => {
                    setStep(1);
                    setCadPayload(null);
                    setMeasurePoints([]);
                    setSourceMeta(null);
                    setSourceFileName('');
                    setCadFileName('');
                    setError('');
                  }}
                >
                  Reset
                </Button>
              </div>

              <ProgressBar now={progress} label={`${progress}%`} />
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {error && (
        <Row className="mb-3">
          <Col>
            <Alert variant="danger">{error}</Alert>
          </Col>
        </Row>
      )}

      {isProcessing && (
        <Row className="mb-3">
          <Col className="d-flex align-items-center gap-2 text-muted">
            <Spinner animation="border" size="sm" />
            Processing uploaded source…
          </Col>
        </Row>
      )}

      <Row className="g-3">
        <Col lg={3} xl={2}>
          {renderStepOne()}
        </Col>
        <Col lg={3} xl={2}>
          {renderStepTwo()}
        </Col>
        <Col lg={3} xl={2}>
          {renderStepThree()}
        </Col>
        <Col lg={3} xl={6}>
          {renderStepFour()}
        </Col>
      </Row>
    </Container>
  );
};

export default LageplanWizardView;
