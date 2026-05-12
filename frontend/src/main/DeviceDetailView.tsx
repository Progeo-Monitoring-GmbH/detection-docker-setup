import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { Button, Container, Form, Card, Spinner, Alert } from 'react-bootstrap';
import { ArrowLeft, Trash, Floppy, Image } from 'react-bootstrap-icons';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';

type DeviceFormData = {
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

type DeviceModel = DeviceFormData & {
  id: number;
  raw_hash: string;
};

const initialFormData: DeviceFormData = {
  hardware: '',
  version: '',
  chip_id: '',
  mac: '',
  project_id: '',
  device_ip: '',
  has_internet: false,
  data_interval: 3600,
  pull_resistance: 136,
};

const DeviceDetailView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [device, setDevice] = useState<DeviceModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<DeviceFormData>(initialFormData);

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
          setFormData({
            hardware: deviceData.hardware || '',
            version: deviceData.version || '',
            chip_id: deviceData.chip_id || '',
            mac: deviceData.mac || '',
            project_id: deviceData.project_id || '',
            device_ip: deviceData.device_ip || '',
            has_internet: deviceData.has_internet || false,
            data_interval: deviceData.data_interval || 3600,
            pull_resistance: deviceData.pull_resistance || 136,
          });
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

  const handleInputChange = (e: any) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : type === 'number' ? Number(value) : value,
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    axiosConfig.updateToken();
    void axiosConfig.holder.put(`/v1/device/${id}/`, formData).then(
      (response) => {
        showSuccessBar(enqueueSnackbar, 'Device updated successfully');
        setDevice(response?.data as DeviceModel);
        setSaving(false);
      },
      (error) => {
        if (error?.response?.status === 401 && auth?.token) {
          auth.navigate(`/login?forward=${auth.location}`);
          return;
        }
        showErrorBar(enqueueSnackbar, `Could not update device: ${error.message}`);
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
        setSaving(false);
      },
    );
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this device? This action cannot be undone.')) {
      return;
    }

    setSaving(true);
    axiosConfig.updateToken();
    void axiosConfig.holder.delete(`/v1/device/${id}/`).then(
      () => {
        showSuccessBar(enqueueSnackbar, 'Device deleted successfully');
        navigate('/device');
      },
      (error) => {
        if (error?.response?.status === 401 && auth?.token) {
          auth.navigate(`/login?forward=${auth.location}`);
          return;
        }
        showErrorBar(enqueueSnackbar, `Could not delete device: ${error.message}`);
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
        setSaving(false);
      },
    );
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
        <Button variant="outline-primary" onClick={() => navigate('/device')}>
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
        onClick={() => navigate('/device')}
      >
        <ArrowLeft className="me-2" />
        Back to Devices
      </Button>

      <Card>
        <Card.Header>
          <h3 className="mb-0">Edit Device: {device.raw_hash}</h3>
        </Card.Header>
        <Card.Body>
          <Form>
            <Form.Group className="mb-3">
              <Form.Label>Hardware</Form.Label>
              <Form.Control
                type="text"
                name="hardware"
                value={formData.hardware}
                onChange={handleInputChange}
                placeholder="Enter hardware name"
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Version</Form.Label>
              <Form.Control
                type="text"
                name="version"
                value={formData.version}
                onChange={handleInputChange}
                placeholder="Enter version"
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Chip ID</Form.Label>
              <Form.Control
                type="text"
                name="chip_id"
                value={formData.chip_id}
                onChange={handleInputChange}
                placeholder="Enter chip ID"
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>MAC Address</Form.Label>
              <Form.Control
                type="text"
                name="mac"
                value={formData.mac}
                onChange={handleInputChange}
                placeholder="Enter MAC address"
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Project ID</Form.Label>
              <Form.Control
                type="text"
                name="project_id"
                value={formData.project_id}
                onChange={handleInputChange}
                placeholder="Enter project ID"
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Device IP</Form.Label>
              <Form.Control
                type="text"
                name="device_ip"
                value={formData.device_ip}
                onChange={handleInputChange}
                placeholder="Enter device IP address"
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Data Interval (seconds)</Form.Label>
              <Form.Control
                type="number"
                name="data_interval"
                value={formData.data_interval}
                onChange={handleInputChange}
                placeholder="Enter data interval"
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Pull Resistance</Form.Label>
              <Form.Select
                name="pull_resistance"
                value={formData.pull_resistance}
                onChange={handleInputChange}
              >
                <option value={136}>100K Ohm (Default)</option>
                <option value={72}>10K Ohm</option>
                <option value={40}>1K Ohm</option>
                <option value={24}>100 Ohm</option>
                <option value={8}>Off</option>
              </Form.Select>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Check
                type="checkbox"
                name="has_internet"
                label="Has Internet"
                checked={formData.has_internet}
                onChange={handleInputChange}
              />
            </Form.Group>

            <div className="d-flex gap-2 flex-wrap">
              <Button
                variant="success"
                onClick={handleSave}
                disabled={saving}
              >
                <Floppy className="me-2" />
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>

              <Button
                variant="outline-info"
                onClick={() => navigate(`/device/${id}/editor/`)}
                disabled={saving}
              >
                <Image className="me-2" />
                Open Editor
              </Button>

              <Button
                variant="danger"
                onClick={handleDelete}
                disabled={saving}
              >
                <Trash className="me-2" />
                Delete Device
              </Button>
            </div>
          </Form>
        </Card.Body>
      </Card>
    </Container>
  );
};

export default DeviceDetailView;
