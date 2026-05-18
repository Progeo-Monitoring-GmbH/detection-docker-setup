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

type DeviceConfigForm = {
  wifi_ssid: string;
  wifi_pwd: string;
  device_model: string;
  device_version: string;
  device_project_id: string;
  device_hash: string;
  measurement_pulldown_hex: number;
  measurement_interval_sec: number;
  measurement_sensors: number;
  measurement_protective_earth: number;
};

const CONFIG_PATH = 'config/device_config.lua';

const defaultConfigForm: DeviceConfigForm = {
  wifi_ssid: '',
  wifi_pwd: '',
  device_model: 'smart',
  device_version: '',
  device_project_id: '',
  device_hash: '',
  measurement_pulldown_hex: 136,
  measurement_interval_sec: 3600,
  measurement_sensors: 16,
  measurement_protective_earth: 0,
};

const sectionContent = (lua: string, section: string) => {
  const match = lua.match(new RegExp(`${section}\\s*=\\s*\\{([\\s\\S]*?)\\}`, 'i'));
  return match ? match[1] : '';
};

const getStringField = (sectionBody: string, key: string) => {
  const match = sectionBody.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i'));
  return match ? match[1] : '';
};

const getNumberField = (sectionBody: string, key: string, fallback = 0) => {
  const match = sectionBody.match(new RegExp(`${key}\\s*=\\s*(-?\\d+)`, 'i'));
  if (!match) {
    return fallback;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseConfigContent = (lua: string, current: DeviceConfigForm): DeviceConfigForm => {
  const wifi = sectionContent(lua, 'wifi');
  const device = sectionContent(lua, 'device');
  const measurement = sectionContent(lua, 'measurement');

  return {
    wifi_ssid: getStringField(wifi, 'ssid') || current.wifi_ssid,
    wifi_pwd: getStringField(wifi, 'pwd') || current.wifi_pwd,
    device_model: getStringField(device, 'model') || current.device_model,
    device_version: getStringField(device, 'version') || current.device_version,
    device_project_id: getStringField(device, 'project_id') || current.device_project_id,
    device_hash: getStringField(device, 'device_hash') || current.device_hash,
    measurement_pulldown_hex: getNumberField(measurement, 'pulldown_hex', current.measurement_pulldown_hex),
    measurement_interval_sec: getNumberField(measurement, 'interval_sec', current.measurement_interval_sec),
    measurement_sensors: getNumberField(measurement, 'sensors', current.measurement_sensors),
    measurement_protective_earth: getNumberField(measurement, 'protective_earth', current.measurement_protective_earth),
  };
};

const toLuaConfig = (config: DeviceConfigForm) => `return {
  wifi = {
    ssid = "${config.wifi_ssid}",
    pwd = "${config.wifi_pwd}"
  },
  device = {
    model = "${config.device_model}",
    version = "${config.device_version}",
    project_id = "${config.device_project_id}",
    device_hash = "${config.device_hash}"
  },
  measurement = {
    pulldown_hex = ${config.measurement_pulldown_hex},
    interval_sec = ${config.measurement_interval_sec},
    sensors = ${config.measurement_sensors},
    protective_earth = ${config.measurement_protective_earth}
  }
}
`;

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
  const [configFields, setConfigFields] = useState<DeviceConfigForm>(defaultConfigForm);
  const [configContent, setConfigContent] = useState(toLuaConfig(defaultConfigForm));

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
          const pull = deviceData.pull_resistance || 136;
          setPullResistance(pull);
          setConfigFields((previous) => {
            const next = {
              ...previous,
              device_project_id: deviceData.project_id || previous.device_project_id,
              device_hash: deviceData.raw_hash || previous.device_hash,
              measurement_interval_sec: deviceData.data_interval || previous.measurement_interval_sec,
              measurement_pulldown_hex: pull,
            };
            setConfigContent(toLuaConfig(next));
            return next;
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

  const handleLoadConfig = async () => {
    try {
      setLoadingConfig(true);
      axiosConfig.updateToken();
      const response = await axiosConfig.holder.get(`/v1/device/${id}/config/download/`, {
        params: { path: CONFIG_PATH },
      });
      const text = response?.data?.content || '';
      const parsed = parseConfigContent(text, configFields);
      setConfigFields(parsed);
      setPullResistance(parsed.measurement_pulldown_hex);
      setConfigContent(toLuaConfig(parsed));
      showSuccessBar(enqueueSnackbar, 'Config loaded successfully');
    } catch (error: any) {
      const reason = error?.response?.data?.reason || error.message;
      showErrorBar(enqueueSnackbar, `Could not load config: ${reason}`);
      console.error(error);
    } finally {
      setLoadingConfig(false);
    }
  };

  const handleSaveConfig = async () => {
    try {
      setSavingConfig(true);
      axiosConfig.updateToken();
      const content = toLuaConfig(configFields);
      setConfigContent(content);
      await axiosConfig.holder.post(`/v1/device/${id}/config/upload/`, {
        path: CONFIG_PATH,
        content,
      });
      showSuccessBar(enqueueSnackbar, 'Config saved successfully');
    } catch (error: any) {
      const reason = error?.response?.data?.reason || error.message;
      showErrorBar(enqueueSnackbar, `Could not save config: ${reason}`);
      console.error(error);
    } finally {
      setSavingConfig(false);
    }
  };

  const handlePullResistanceChange = (e: any) => {
    const value = Number(e.target.value);
    setPullResistance(value);
    setConfigFields((previous) => {
      const next = { ...previous, measurement_pulldown_hex: value };
      setConfigContent(toLuaConfig(next));
      return next;
    });
  };

  const handleFieldChange = (name: keyof DeviceConfigForm, value: string | number) => {
    setConfigFields((previous) => {
      const next = { ...previous, [name]: value };
      setConfigContent(toLuaConfig(next));
      return next;
    });
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
              <Form.Label>Device IP</Form.Label>
              <Form.Control
                type="text"
                value={device.device_ip || ''}
                readOnly
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>WiFi SSID</Form.Label>
              <Form.Control
                type="text"
                value={configFields.wifi_ssid}
                onChange={(e) => handleFieldChange('wifi_ssid', e.target.value)}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>WiFi Password</Form.Label>
              <Form.Control
                type="text"
                value={configFields.wifi_pwd}
                onChange={(e) => handleFieldChange('wifi_pwd', e.target.value)}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Model</Form.Label>
              <Form.Control
                type="text"
                value={configFields.device_model}
                onChange={(e) => handleFieldChange('device_model', e.target.value)}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Version</Form.Label>
              <Form.Control
                type="text"
                value={configFields.device_version}
                onChange={(e) => handleFieldChange('device_version', e.target.value)}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Project ID</Form.Label>
              <Form.Control
                type="text"
                value={configFields.device_project_id}
                onChange={(e) => handleFieldChange('device_project_id', e.target.value)}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Device Hash</Form.Label>
              <Form.Control
                type="text"
                value={configFields.device_hash}
                onChange={(e) => handleFieldChange('device_hash', e.target.value)}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Pull Resistance</Form.Label>
              <Form.Select
                name="pull_resistance"
                value={pullResistance}
                onChange={handlePullResistanceChange}
              >
                <option value={132}>132 (Device Default)</option>
                <option value={136}>100K Ohm (Default)</option>
                <option value={72}>10K Ohm</option>
                <option value={40}>1K Ohm</option>
                <option value={24}>100 Ohm</option>
                <option value={8}>Off</option>
              </Form.Select>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Interval (seconds)</Form.Label>
              <Form.Control
                type="number"
                value={configFields.measurement_interval_sec}
                onChange={(e) => handleFieldChange('measurement_interval_sec', Number(e.target.value) || 0)}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Sensors</Form.Label>
              <Form.Control
                type="number"
                value={configFields.measurement_sensors}
                onChange={(e) => handleFieldChange('measurement_sensors', Number(e.target.value) || 0)}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Protective Earth</Form.Label>
              <Form.Control
                type="number"
                value={configFields.measurement_protective_earth}
                onChange={(e) => handleFieldChange('measurement_protective_earth', Number(e.target.value) || 0)}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Config Preview</Form.Label>
              <Form.Control
                as="textarea"
                rows={14}
                value={configContent}
                readOnly
                placeholder="Load config to inspect current device_config.lua"
              />
            </Form.Group>

            <div className="d-flex gap-2 flex-wrap">
              <Button
                type="button"
                variant="primary"
                onClick={handleLoadConfig}
                disabled={loadingConfig || savingConfig}
              >
                {loadingConfig ? 'Loading...' : 'Load Config'}
              </Button>

              <Button
                type="button"
                variant="success"
                onClick={handleSaveConfig}
                disabled={savingConfig || loadingConfig}
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
