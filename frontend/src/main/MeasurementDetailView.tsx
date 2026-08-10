import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Button, Card, Container, Spinner } from 'react-bootstrap';
import { ArrowLeft } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig.tsx';
import MeasurementSamplesCompareChart, {
  type MeasurementCompareRow,
} from '../components/device/MeasurementSamplesCompareChart.tsx';
import { showErrorBar } from '../components/ui/Snackbar.jsx';

type DeviceSummary = {
  id: number;
  raw_hash?: string | null;
  mac?: string | null;
};

const MeasurementDetailView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [loading, setLoading] = useState(false);
  const [device, setDevice] = useState<DeviceSummary | null>(null);
  const [rows, setRows] = useState<MeasurementCompareRow[]>([]);
  const [filterMode, setFilterMode] = useState<'all' | 'last10'>('all');

  const filteredRows = filterMode === 'last10' ? rows.slice(0, 10) : rows;

  const loadMeasurements = (year?: number) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (year) {
      params.set('year', String(year));
    } else {
      params.set('limit', '300');
    }

    void axiosConfig.perform_get(
      auth,
      `/v1/device/${id}/measurements/?${params.toString()}`,
      (response) => {
        const payload = response?.data || {};
        const nextDevice = (payload.device || null) as DeviceSummary | null;
        const measurements = (payload.measurements ||
          []) as MeasurementCompareRow[];

        setDevice(nextDevice);
        setRows(measurements);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load measurements: ${reason}`);
        setRows([]);
        setDevice(null);
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    loadMeasurements();
  }, [id]);

  return (
    <Container className="py-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <Button
          variant="outline-secondary"
          onClick={() => navigate('/device/overview/')}
        >
          <ArrowLeft className="me-2" />
          Back to Devices
        </Button>

        <Button variant="outline-primary" onClick={loadMeasurements}>
          Refresh
        </Button>
      </div>

      <Card className="border-0 shadow-sm mb-3">
        <Card.Body>
          <h4 className="mb-1">Measurement Detail</h4>
          <div className="text-muted small">
            Device {id}
            {device?.raw_hash ? ` | ${device.raw_hash}` : ''}
            {device?.mac ? ` | ${device.mac}` : ''}
          </div>
        </Card.Body>
      </Card>

      <Card className="border-0 shadow-sm mb-3">
        <Card.Body className="d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div className="text-muted small">
            Filtered rows: {filteredRows.length} / {rows.length}
          </div>
          <div className="d-flex gap-2">
            <Button
              variant={filterMode === 'all' ? 'primary' : 'outline-primary'}
              onClick={() => setFilterMode('all')}
              disabled={loading || rows.length === 0}
            >
              Show All
            </Button>
            <Button
              variant={filterMode === 'last10' ? 'primary' : 'outline-primary'}
              onClick={() => setFilterMode('last10')}
              disabled={loading || rows.length === 0}
            >
              Last 10
            </Button>
          </div>
        </Card.Body>
      </Card>

      {loading ? (
        <Card className="border-0 shadow-sm">
          <Card.Body className="d-flex align-items-center gap-2 text-muted">
            <Spinner size="sm" animation="border" />
            Loading measurements...
          </Card.Body>
        </Card>
      ) : filteredRows.length === 0 ? (
        <Card className="border-0 shadow-sm">
          <Card.Body className="text-muted">
            No measurements found for this device.
          </Card.Body>
        </Card>
      ) : (
        <>
          <p className="text-muted mb-3">
            Plotting {filteredRows.length} measurements for this device. Each
            line is one measurement.
          </p>
          <MeasurementSamplesCompareChart
            rows={filteredRows}
            onLoadCurrentYear={() => loadMeasurements(new Date().getFullYear())}
            isLoadingCurrentYear={loading}
          />
        </>
      )}
    </Container>
  );
};

export default MeasurementDetailView;
