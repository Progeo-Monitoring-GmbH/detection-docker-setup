import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { Button, Container, Form, Card, Spinner, Alert } from 'react-bootstrap';
import { ArrowLeft } from 'react-bootstrap-icons';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';

type DeviceData = {
  hardware: string;
  version: string;
  chip_id: string;
  mac: string;
  project_id: string;
  device_ip: string;
  has_internet: boolean;
  data_interval: number;
  pull_resistance: number;
};

type DeviceModel = DeviceData & {
  id: number;
  raw_hash: string;
};

const CONFIG_PATH = 'config%2Fdevice_config.lua';

const normalizeDeviceUrl = (deviceIp: string) => {
  const trimmed = deviceIp.trim();
  if (!trimmed) {
    return '';
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
};

const updatePullResistanceInConfig = (content: string, value: number) => {
  if (!content.trim()) {
    return `pull_resistance = ${value}\n`;
  }

  const patterns: RegExp[] = [
    /(pull_resistance\s*=\s*)(\d+)/i,
    /(["']pull_resistance["']\s*=\s*)(\d+)/i,
    /(["']pull_resistance["']\s*:\s*)(\d+)/i,
  ];

  for (const pattern of patterns) {
    if (pattern.test(content)) {
      return content.replace(pattern, `$1${value}`);
    }
  }

  return `${content.trimEnd()}\npull_resistance = ${value}\n`;
};

const extractPullResistanceFromConfig = (content: string) => {
  const match = content.match(/pull_resistance\s*[=:]\s*(\d+)/i) || content.match(/["']pull_resistance["']\s*[=:]\s*(\d+)/i);
  if (!match) {
    return null;
  }
  return Number(match[1]);
};

const DeviceDetailView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [device, setDevice] = useState<DeviceModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [pullResistance, setPullResistance] = useState(136);
  const [configContent, setConfigContent] = useState('');

  useEffect(() => {
    fetchDevice();
  }, [id]);

  const fetchDevice = async () => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/device/${id}/`,
      (response) => {
        const deviceData = response?.data as DeviceModel | undefined;
        if (deviceData) {
          setDevice(deviceData);
          setPullResistance(deviceData.pull_resistance || 136);
        }
        setLoading(false);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, `Could not fetch device: ${error.message}`);
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
        setLoading(false);
      },
    );
  };

  const getDeviceConfigUrl = (operation: 'download' | 'upload') => {
    const baseUrl = normalizeDeviceUrl(device?.device_ip || '');
    if (!baseUrl) {
      throw new Error('Device IP is missing');
    }
    return `${baseUrl}/${operation}?path=${CONFIG_PATH}`;
  };

  const handleLoadConfig = async () => {
    try {
      setLoadingConfig(true);
      const response = await fetch(getDeviceConfigUrl('download'));
      if (!response.ok) {
        throw new Error(`Load failed (${response.status})`);
      }
      const text = await response.text();
      setConfigContent(text);
      const extracted = extractPullResistanceFromConfig(text);
      if (extracted !== null) {
        setPullResistance(extracted);
      }
      showSuccessBar(enqueueSnackbar, 'Config loaded successfully');
    } catch (error: any) {
      showErrorBar(enqueueSnackbar, `Could not load config: ${error.message}`);
      console.error(error);
    } finally {
      setLoadingConfig(false);
    }
  };

  const handleSaveConfig = async () => {
    try {
      setSavingConfig(true);
      const response = await fetch(getDeviceConfigUrl('upload'), {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: configContent,
      });
      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`);
      }
      showSuccessBar(enqueueSnackbar, 'Config saved successfully');
    } catch (error: any) {
      showErrorBar(enqueueSnackbar, `Could not save config: ${error.message}`);
      console.error(error);
    } finally {
      setSavingConfig(false);
    }
  };

  const handlePullResistanceChange = (e: any) => {
    const value = Number(e.target.value);
    setPullResistance(value);
    setConfigContent((previous) => updatePullResistanceInConfig(previous, value));
  };

  if (loading) {
    return (
      <Container className="d-flex justify-content-center align-items-center" style={{ minHeight: '50vh' }}>
        <Spinner animation="border" role="status">
          <span className="visually-hidden">Loading...</span>
        </Spinner>
      </Container>
    );
  }

  if (!device) {
    return (
      <Container className="py-4">
        <Alert variant="danger">Device not found</Alert>
        <Button variant="outline-primary" onClick={() => navigate('/device/overview/')}>
          <ArrowLeft className="me-2" />
          Back to Devices
        </Button>
      </Container>
    );
  }

  return (
    <Container className="py-4">
      <Button 
        variant="outline-secondary" 
        className="mb-3"
        onClick={() => navigate('/device/overview/')}
      >
        <ArrowLeft className="me-2" />
        Back to Devices
      </Button>

      <Card>
        <Card.Header>
          <h3 className="mb-0">Device Config: {device.raw_hash}</h3>
        </Card.Header>
        <Card.Body>
          <Form>
            <Form.Group className="mb-3">
              <Form.Label>Version</Form.Label>
              <Form.Control
                type="text"
                value={device.version || ''}
                readOnly
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Project ID</Form.Label>
              <Form.Control
                type="text"
                value={device.project_id || ''}
                readOnly
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Data Interval (seconds)</Form.Label>
              <Form.Control
                type="number"
                value={device.data_interval || 3600}
                readOnly
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Pull Resistance</Form.Label>
              <Form.Select
                name="pull_resistance"
                value={pullResistance}
                onChange={handlePullResistanceChange}
              >
                <option value={136}>100K Ohm (Default)</option>
                <option value={72}>10K Ohm</option>
                <option value={40}>1K Ohm</option>
                <option value={24}>100 Ohm</option>
                <option value={8}>Off</option>
              </Form.Select>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Device Config Content</Form.Label>
              <Form.Control
                as="textarea"
                rows={14}
                value={configContent}
                readOnly
                placeholder="Click Load Config to fetch config/device_config.lua"
              />
            </Form.Group>

            <div className="d-flex gap-2 flex-wrap">
              <Button
                type="button"
                variant="primary"
                onClick={handleLoadConfig}
                disabled={loadingConfig || savingConfig || !device.device_ip}
              >
                {loadingConfig ? 'Loading...' : 'Load Config'}
              </Button>

              <Button
                type="button"
                variant="success"
                onClick={handleSaveConfig}
                disabled={savingConfig || loadingConfig || !configContent.trim() || !device.device_ip}
              >
                {savingConfig ? 'Saving...' : 'Save Config'}
              </Button>
            </div>
          </Form>
        </Card.Body>
      </Card>
    </Container>
  );
};

export default DeviceDetailView;
