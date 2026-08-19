import { useEffect, useState } from 'react';
import { Button, Card, Container, Spinner } from 'react-bootstrap';
import { ArrowLeft, Grid3x3Gap } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig.tsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import {
  type SensorHeatmapLocation,
  type SensorHeatmapResponse,
} from '../components/device/SensorHeatmap3D.tsx';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';

const MAX_LIMIT = 2000;
const LOAD_MORE_STEP = 100;

const LocationHeatmap2DView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [searchParams] = useSearchParams();
  const withSliders =
    searchParams.get('with_sliders') === 'true' ||
    searchParams.get('with_silder') === 'true';
  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState<SensorHeatmapResponse | null>(null);
  const [limit, setLimit] = useState(10);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [alignment, setAlignment] = useState<SensorHeatmapLocation | null>(
    null,
  );
  const [saving, setSaving] = useState(false);

  const loadHeatmap = (requestedLimit: number) => {
    if (!id) {
      return;
    }

    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${id}/heatmap/?limit=${requestedLimit}`,
      (result) => {
        setResponse((result?.data || null) as SensorHeatmapResponse | null);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          enqueueSnackbar,
          `Could not load location heatmap: ${reason}`,
        );
        setResponse(null);
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    if (!id) {
      return undefined;
    }

    setLoading(true);
    const timeoutId = window.setTimeout(() => {
      loadHeatmap(limit);
    }, 900);

    return () => window.clearTimeout(timeoutId);
  }, [id, limit, reloadVersion]);

  useEffect(() => {
    setAlignment(null);
  }, [id]);

  // Seed the alignment sliders from the location when the response arrives
  // (or when the location reloads), but keep manual edits while on this page.
  // The id guard prevents seeding from a stale response of a previous
  // location while a new fetch is still in flight.
  useEffect(() => {
    if (!withSliders) {
      return;
    }
    const loc = response?.location;
    if (!loc || loc.id == null || String(loc.id) !== String(id)) {
      return;
    }
    setAlignment((current) => {
      if (current) {
        return current;
      }
      return {
        lageplan_url: loc.lageplan_url ?? null,
        offset_x: loc.offset_x ?? 0,
        offset_y: loc.offset_y ?? 0,
        scale_x: loc.scale_x ?? 1,
        scale_y: loc.scale_y ?? 1,
      };
    });
  }, [withSliders, response, id]);

  const projectId = response?.location?.project_id;

  const saveAlignment = () => {
    if (!alignment || projectId == null) {
      showErrorBar(
        enqueueSnackbar,
        'No location available to store the alignment for.',
      );
      return;
    }

    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/location/update/',
      {
        location_id: projectId,
        offset_x: alignment.offset_x ?? 0,
        offset_y: alignment.offset_y ?? 0,
        scale_x: alignment.scale_x ?? 1,
        scale_y: alignment.scale_y ?? 1,
      },
      () => {
        showSuccessBar(enqueueSnackbar, 'Alignment stored.');
        setSaving(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not store alignment: ${reason}`);
        setSaving(false);
      },
    );
  };

  const setAlignmentValue = (
    key: 'offset_x' | 'offset_y' | 'scale_x' | 'scale_y',
    value: number,
  ) => {
    setAlignment((current) => ({ ...(current ?? {}), [key]: value }));
  };

  const resetAlignmentValues = () => {
    setAlignment((current) =>
      current
        ? { ...current, offset_x: 0, offset_y: 0, scale_x: 1, scale_y: 1 }
        : current,
    );
  };

  return (
    <Container className="py-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3 p-3">
        <div className="d-flex gap-2">
          <Button
            variant="outline-secondary"
            onClick={() => navigate('/location/overview/')}
          >
            <ArrowLeft className="me-2" />
            Back to Locations
          </Button>
          <Button
            variant="outline-primary"
            onClick={() => navigate(`/location/${id}/heatplot`)}
          >
            <Grid3x3Gap className="me-2" />
            3D Heatmap
          </Button>
        </div>

        <Button
          variant="outline-primary"
          onClick={() => setReloadVersion((version) => version + 1)}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      <Card className="border-0 shadow-sm mb-3 p-3">
        <Card.Body>
          <h4 className="mb-1">Location Heatmap (2D)</h4>
          <div className="text-muted small">Location {id}</div>
          <label htmlFor="heatmap2d-limit" className="form-label mt-3 mb-1">
            Measurements: {limit}
          </label>
          <input
            id="heatmap2d-limit"
            type="range"
            className="form-range"
            min={1}
            max={MAX_LIMIT}
            step={1}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            aria-valuemin={1}
            aria-valuemax={MAX_LIMIT}
            aria-valuenow={limit}
          />
          <div className="d-flex justify-content-between align-items-center text-muted small">
            <span>1</span>
            <div className="d-flex align-items-center gap-2">
              <span>
                Loaded {limit} of up to {MAX_LIMIT} measurements
              </span>
              <Button
                size="sm"
                variant="outline-primary"
                onClick={() =>
                  setLimit((current) =>
                    Math.min(current + LOAD_MORE_STEP, MAX_LIMIT),
                  )
                }
                disabled={loading || limit >= MAX_LIMIT}
              >
                Load more (+{LOAD_MORE_STEP})
              </Button>
            </div>
            <span>{MAX_LIMIT}</span>
          </div>
        </Card.Body>
      </Card>

      {withSliders && (
        <Card className="border-0 shadow-sm mb-3 p-3">
          <Card.Body>
            <h5 className="mb-2">Alignment sliders</h5>
            <div className="row g-2">
              <div className="col-md-6">
                <label
                  htmlFor="heatmap2d-align-offset-x"
                  className="form-label small mb-0"
                >
                  offsetX: {alignment?.offset_x ?? 0}
                </label>
                <input
                  id="heatmap2d-align-offset-x"
                  className="form-range"
                  type="range"
                  min={-250}
                  max={250}
                  step={1}
                  value={alignment?.offset_x ?? 0}
                  onChange={(event) =>
                    setAlignmentValue('offset_x', Number(event.target.value))
                  }
                />
              </div>
              <div className="col-md-6">
                <label
                  htmlFor="heatmap2d-align-offset-y"
                  className="form-label small mb-0"
                >
                  offsetY: {alignment?.offset_y ?? 0}
                </label>
                <input
                  id="heatmap2d-align-offset-y"
                  className="form-range"
                  type="range"
                  min={-250}
                  max={250}
                  step={1}
                  value={alignment?.offset_y ?? 0}
                  onChange={(event) =>
                    setAlignmentValue('offset_y', Number(event.target.value))
                  }
                />
              </div>
              <div className="col-md-6">
                <label
                  htmlFor="heatmap2d-align-scale-x"
                  className="form-label small mb-0"
                >
                  scaleX: {(alignment?.scale_x ?? 1).toFixed(2)}
                </label>
                <input
                  id="heatmap2d-align-scale-x"
                  className="form-range"
                  type="range"
                  min={0.1}
                  max={5}
                  step={0.01}
                  value={alignment?.scale_x ?? 1}
                  onChange={(event) =>
                    setAlignmentValue('scale_x', Number(event.target.value))
                  }
                />
              </div>
              <div className="col-md-6">
                <label
                  htmlFor="heatmap2d-align-scale-y"
                  className="form-label small mb-0"
                >
                  scaleY: {(alignment?.scale_y ?? 1).toFixed(2)}
                </label>
                <input
                  id="heatmap2d-align-scale-y"
                  className="form-range"
                  type="range"
                  min={0.1}
                  max={5}
                  step={0.01}
                  value={alignment?.scale_y ?? 1}
                  onChange={(event) =>
                    setAlignmentValue('scale_y', Number(event.target.value))
                  }
                />
              </div>
              <div className="col-12 d-flex gap-2">
                <Button
                  variant="primary"
                  onClick={saveAlignment}
                  disabled={saving || !alignment || projectId == null}
                >
                  {saving ? 'Storing\u2026' : 'Store alignment'}
                </Button>
                <Button
                  variant="outline-secondary"
                  onClick={resetAlignmentValues}
                >
                  Reset values
                </Button>
              </div>
            </div>
          </Card.Body>
        </Card>
      )}

      {loading ? (
        <Card className="border-0 shadow-sm p-3">
          <Card.Body className="d-flex align-items-center gap-2 text-muted">
            <Spinner size="sm" animation="border" />
            Loading sensor measurements...
          </Card.Body>
        </Card>
      ) : (
        <SensorHeatmap2D
          response={response}
          alignment={withSliders ? alignment : null}
        />
      )}
    </Container>
  );
};

export default LocationHeatmap2DView;
