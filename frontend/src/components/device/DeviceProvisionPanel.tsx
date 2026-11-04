import { useEffect, useState } from 'react';
import { Alert, Button, Col, Form, Row, Spinner } from 'react-bootstrap';
import { CheckCircle, Clipboard, Download, FileEarmarkCode } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { downloadBlob } from '../../download';
import { showErrorBar, showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PanelCard from '../ui/kit/PanelCard';

/** A location of /v1/device/provision/locations/ (model: its default device.model). */
type ProvisionLocation = {
  id: number;
  project_id: number;
  name: string | null;
  project_type: string;
  model: string;
};

type Option = { value: number; label: string };

/** A flash bundle the server holds (firmware.list_bundles, newest first). */
type FirmwareBundle = {
  id: string;
  release: string | null;
  firmware: string | null;
  created: string | null;
  channels: string[];
  /** Channels whose "latest" it is. */
  latest_in: string[];
};

type ProvisionSettings = {
  model: string;
  /** Bundle id; '' while the server holds none (the config gets the fallback version). */
  firmware: string;
  sensors: string;
  interval_sec: string;
  pulldown_resistance: string;
  protective_earth: boolean;
  wifi_ssid: string;
  wifi_pwd: string;
};

type QrCode = { payload: string; image: string };

type ProvisionPreview = {
  device_hash: string;
  project_id: number;
  model: string;
  firmware_version: string;
  firmware_bundle: string | null;
  token: string;
  url: string;
  config: string;
  signed: string;
  portal: {
    wifi: QrCode & { ssid: string };
    frontend: QrCode & { url: string };
  };
};

export type ProvisionedDevice = { id: number; location: number; raw_hash: string };

const EMPTY_SETTINGS: ProvisionSettings = {
  model: '',
  firmware: '',
  sensors: '32',
  interval_sec: '1800',
  pulldown_resistance: '136',
  protective_earth: false,
  wifi_ssid: '',
  wifi_pwd: '',
};

/** ASCII only, like the backend's ascii_model: "smartex® mx-va" -> "smartex mx-va". */
const asciiModel = (label: string) =>
  label
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * "Gerät hinzufügen" of the device overview (formerly /device/provision/):
 * set the measurement settings and the device.model of a new smartex
 * controller for `locationId`, generate its config (device_hash + transfer
 * token come from the backend) and confirm - the device is then filed under
 * the location and can send its samples. `onCreated` gets the new device
 * (the overview shows its test measurements).
 */
const DeviceProvisionPanel = ({
  locationId,
  onCreated,
  onClose,
}: {
  locationId: number;
  onCreated: (device: ProvisionedDevice) => void;
  onClose: () => void;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();

  const [locations, setLocations] = useState<ProvisionLocation[] | null>(null);
  const [resistances, setResistances] = useState<Option[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [bundles, setBundles] = useState<FirmwareBundle[]>([]);
  const [firmwareFallback, setFirmwareFallback] = useState('');
  const [settings, setSettings] = useState<ProvisionSettings>(EMPTY_SETTINGS);
  const [preview, setPreview] = useState<ProvisionPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/device/provision/locations/',
      (response) => {
        const data = response?.data || {};
        setLocations((data.locations || []) as ProvisionLocation[]);
        setResistances((data.pulldown_resistances || []) as Option[]);
        setModels(((data.models || []) as string[]).map(asciiModel));
        setBundles((data.firmware_bundles || []) as FirmwareBundle[]);
        setFirmwareFallback(String(data.firmware_fallback || ''));
        const defaults = data.defaults || {};
        setSettings((current) => ({
          ...current,
          firmware: String(defaults.firmware ?? ''),
          sensors: String(defaults.sensors ?? current.sensors),
          interval_sec: String(defaults.interval_sec ?? current.interval_sec),
          pulldown_resistance: String(defaults.pulldown_resistance ?? current.pulldown_resistance),
        }));
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('provision_load_failed'), error);
        setLocations([]);
      },
    );
    // Once - auth changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const location = locations?.find((entry) => entry.id === locationId) ?? null;

  // Another location: its own default model, and the old preview is stale.
  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
    if (location) {
      setSettings((current) => ({ ...current, model: asciiModel(location.model || '') }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, location?.model]);

  const updateSetting = <K extends keyof ProvisionSettings>(key: K, value: ProvisionSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    // Any change makes the generated config stale - generate it again.
    setPreview(null);
    setConfirmed(false);
  };

  const generate = () => {
    setLoading(true);
    setPreview(null);
    setConfirmed(false);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/preview/',
      {
        location: locationId,
        model: asciiModel(settings.model),
        // '': the backend's default bundle (or its fallback version without any).
        firmware: settings.firmware,
        sensors: Number(settings.sensors),
        interval_sec: Number(settings.interval_sec),
        pulldown_resistance: Number(settings.pulldown_resistance),
        protective_earth: settings.protective_earth ? 1 : 0,
        wifi_ssid: settings.wifi_ssid,
        wifi_pwd: settings.wifi_pwd,
      },
      (response) => {
        setPreview((response?.data || null) as ProvisionPreview | null);
        setLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not generate config', error);
        setLoading(false);
      },
    );
  };

  const confirm = () => {
    if (!preview) {
      return;
    }
    setLoading(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/confirm/',
      { signed: preview.signed },
      (response) => {
        const device = response?.data?.device;
        setConfirmed(true);
        setLoading(false);
        showSuccessBar(enqueueSnackbar, `Device ${preview.device_hash} created.`);
        if (device?.id != null) {
          onCreated({
            id: Number(device.id),
            location: locationId,
            raw_hash: String(device.raw_hash ?? preview.device_hash),
          });
        }
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not create device', error);
        setLoading(false);
      },
    );
  };

  const copyConfig = () => {
    if (!preview) {
      return;
    }
    navigator.clipboard
      .writeText(preview.config)
      .then(() => showSuccessBar(enqueueSnackbar, 'Config copied.'))
      .catch(() => showErrorBar(enqueueSnackbar, 'Could not copy the config.'));
  };

  const downloadConfig = () => {
    if (preview) {
      downloadBlob(new Blob([preview.config], { type: 'text/plain' }), `device_config_${preview.device_hash}.lua`);
    }
  };

  const portalQrCode = (title: string, caption: string, code: QrCode) => (
    <figure className="m-0 text-center">
      <img src={code.image} alt={title} width={180} height={180} style={{ imageRendering: 'pixelated' }} />
      <figcaption className="small">
        <strong>{title}</strong>
        <br />
        <code>{caption}</code>
      </figcaption>
    </figure>
  );

  return (
    <PanelCard
      title={t('provision_add_title')}
      actions={
        <Button variant="link" size="sm" className="p-0" onClick={onClose}>
          {t('provision_add_close')}
        </Button>
      }
    >
      <div className="small text-muted mb-3">{t('provision_add_hint')}</div>

      {locations === null ? (
        <div className="d-flex align-items-center gap-2 text-muted py-2">
          <Spinner size="sm" animation="border" /> {t('provision_loading')}
        </div>
      ) : !location ? (
        <Alert variant="warning" className="mb-0">
          {t('provision_location_unavailable')}
        </Alert>
      ) : (
        <>
          <Row className="g-3">
            <Col md={4}>
              <Form.Group controlId="provision-model">
                <Form.Label className="text-muted small mb-1">{t('provision_model')}</Form.Label>
                <Form.Select value={settings.model} onChange={(event) => updateSetting('model', event.target.value)}>
                  {/* A default the list lacks stays selectable. */}
                  {settings.model && !models.includes(settings.model) && (
                    <option value={settings.model}>{settings.model}</option>
                  )}
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group controlId="provision-firmware">
                <Form.Label className="text-muted small mb-1">{t('provision_firmware')}</Form.Label>
                {bundles.length === 0 ? (
                  // No bundle on the server: the config gets the built-in version.
                  <Form.Select disabled value="">
                    <option value="">{t('provision_firmware_none', { version: firmwareFallback })}</option>
                  </Form.Select>
                ) : (
                  <Form.Select
                    value={settings.firmware}
                    onChange={(event) => updateSetting('firmware', event.target.value)}
                  >
                    {bundles.map((bundle) => (
                      <option key={bundle.id} value={bundle.id}>
                        {[
                          bundle.id,
                          bundle.firmware,
                          bundle.latest_in.length
                            ? t('provision_firmware_latest', { channels: bundle.latest_in.join(', ') })
                            : bundle.channels.join(', '),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </option>
                    ))}
                  </Form.Select>
                )}
              </Form.Group>
            </Col>
            <Col sm={4} md={2}>
              <Form.Group controlId="provision-sensors">
                <Form.Label className="text-muted small mb-1">Sensors</Form.Label>
                <Form.Control
                  type="number"
                  min={1}
                  value={settings.sensors}
                  onChange={(event) => updateSetting('sensors', event.target.value)}
                />
              </Form.Group>
            </Col>
            <Col sm={4} md={2}>
              <Form.Group controlId="provision-interval">
                <Form.Label className="text-muted small mb-1">Interval (sec)</Form.Label>
                <Form.Control
                  type="number"
                  min={10}
                  max={86400}
                  value={settings.interval_sec}
                  onChange={(event) => updateSetting('interval_sec', event.target.value)}
                />
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group controlId="provision-resistance">
                <Form.Label className="text-muted small mb-1">Pull-down resistance</Form.Label>
                <Form.Select
                  value={settings.pulldown_resistance}
                  onChange={(event) => updateSetting('pulldown_resistance', event.target.value)}
                >
                  {resistances.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.value})
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group controlId="provision-ssid">
                <Form.Label className="text-muted small mb-1">WiFi SSID (optional)</Form.Label>
                <Form.Control
                  value={settings.wifi_ssid}
                  onChange={(event) => updateSetting('wifi_ssid', event.target.value)}
                />
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group controlId="provision-pwd">
                <Form.Label className="text-muted small mb-1">WiFi password (optional)</Form.Label>
                <Form.Control
                  type="password"
                  autoComplete="new-password"
                  value={settings.wifi_pwd}
                  onChange={(event) => updateSetting('wifi_pwd', event.target.value)}
                />
              </Form.Group>
            </Col>
            <Col md={4} className="d-flex align-items-end">
              <Form.Check
                type="switch"
                id="provision-protective-earth"
                label="Protective earth"
                checked={settings.protective_earth}
                onChange={(event) => updateSetting('protective_earth', event.target.checked)}
              />
            </Col>
          </Row>
          <div className="mt-3">
            <Button variant="primary" onClick={generate} disabled={loading || !settings.model}>
              {loading && !preview ? (
                <Spinner size="sm" animation="border" className="me-2" />
              ) : (
                <FileEarmarkCode className="me-2" />
              )}
              Generate config
            </Button>
          </div>

          {preview && (
            <div className="mt-4">
              <dl className="row mb-3">
                <dt className="col-sm-2">Device hash</dt>
                <dd className="col-sm-10">
                  <code>{preview.device_hash}</code>
                </dd>
                <dt className="col-sm-2">{t('provision_model')}</dt>
                <dd className="col-sm-10">
                  <code>{preview.model}</code>
                </dd>
                <dt className="col-sm-2">{t('provision_firmware')}</dt>
                <dd className="col-sm-10">
                  <code>{preview.firmware_version}</code>
                  {preview.firmware_bundle && (
                    <span className="text-muted small ms-2">({preview.firmware_bundle})</span>
                  )}
                </dd>
                <dt className="col-sm-2">Location</dt>
                <dd className="col-sm-10">
                  {location.name || '-'} (project {preview.project_id})
                </dd>
                <dt className="col-sm-2">URL</dt>
                <dd className="col-sm-10 text-break">
                  <code>{preview.url}</code>
                </dd>
                <dt className="col-sm-2">Token</dt>
                <dd className="col-sm-10">
                  <code>{preview.token}</code>
                </dd>
              </dl>

              <Row className="g-3 mb-3">
                <Col lg={8}>
                  <Form.Control
                    as="textarea"
                    readOnly
                    rows={36}
                    value={preview.config}
                    className="font-monospace small"
                    onFocus={(event) => event.target.select()}
                  />
                </Col>
                <Col lg={4}>
                  <div className="d-flex flex-wrap flex-lg-column align-items-center gap-4">
                    {portalQrCode('Setup portal Wi-Fi', preview.portal.wifi.ssid, preview.portal.wifi)}
                    {portalQrCode('Controller', preview.portal.frontend.url, preview.portal.frontend)}
                  </div>
                </Col>
              </Row>

              {confirmed ? (
                <Alert variant="success" className="mb-3">
                  <CheckCircle className="me-2" />
                  Device <code>{preview.device_hash}</code> is created and linked to its location - it is ready to
                  send its data.
                </Alert>
              ) : (
                <Alert variant="warning" className="mb-3">
                  Nothing is saved yet: the token only works once you confirm.
                </Alert>
              )}

              <div className="d-flex flex-wrap gap-2">
                <Button variant="outline-secondary" onClick={copyConfig}>
                  <Clipboard className="me-2" />
                  Copy
                </Button>
                <Button variant="outline-secondary" onClick={downloadConfig}>
                  <Download className="me-2" />
                  Download
                </Button>
                <Button variant="success" onClick={confirm} disabled={loading || confirmed}>
                  {loading ? (
                    <Spinner size="sm" animation="border" className="me-2" />
                  ) : (
                    <CheckCircle className="me-2" />
                  )}
                  Confirm
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </PanelCard>
  );
};

export default DeviceProvisionPanel;
