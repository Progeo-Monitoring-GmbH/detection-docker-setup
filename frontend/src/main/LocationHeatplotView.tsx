import { useEffect, useState } from 'react';
import { Button, Card, Container, Spinner } from 'react-bootstrap';
import { ArrowLeft, Grid3x3Gap } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useNavigate, useParams } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig.tsx';
import SensorHeatmap3D, {
  type SensorHeatmapResponse,
} from '../components/device/SensorHeatmap3D.tsx';
import { showErrorBar } from '../components/ui/Snackbar.jsx';

const LocationHeatplotView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState<SensorHeatmapResponse | null>(null);
  const [limit, setLimit] = useState(10);
  const [reloadVersion, setReloadVersion] = useState(0);

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

  return (
    <Container className="py-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
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
            onClick={() => navigate(`/location/${id}/heatmap2d`)}
          >
            <Grid3x3Gap className="me-2" />
            2D Heatmap
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

      <Card className="border-0 shadow-sm mb-3">
        <Card.Body>
          <h4 className="mb-1">Location Heatplot</h4>
          <div className="text-muted small">Location {id}</div>
          <label htmlFor="heatplot-limit" className="form-label mt-3 mb-1">
            Measurements: {limit}
          </label>
          <input
            id="heatplot-limit"
            type="range"
            className="form-range"
            min={1}
            max={500}
            step={1}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            aria-valuemin={1}
            aria-valuemax={500}
            aria-valuenow={limit}
          />
          <div className="d-flex justify-content-between text-muted small">
            <span>1</span>
            <span>500</span>
          </div>
        </Card.Body>
      </Card>

      {loading ? (
        <Card className="border-0 shadow-sm">
          <Card.Body className="d-flex align-items-center gap-2 text-muted">
            <Spinner size="sm" animation="border" />
            Loading sensor measurements...
          </Card.Body>
        </Card>
      ) : (
        <SensorHeatmap3D
          response={response}
          title={`Location ${id} sensor measurements`}
        />
      )}
    </Container>
  );
};

export default LocationHeatplotView;
