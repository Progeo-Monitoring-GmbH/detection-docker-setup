import { type ReactNode, useEffect, useState } from 'react';
import { Alert, Button, Col, Form, Row, Spinner } from 'react-bootstrap';
import { CheckCircle, Clipboard, FileEarmarkCode, QrCode as QrCodeIcon } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showErrorBar, showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PanelCard from '../ui/kit/PanelCard';
import { bundleVersionLabel, type FirmwareBundle } from './firmwareBundle';
import { repeatedTestId } from '../../testIds';
import './DeviceProvisionPanel.css';

/** A location of /v1/device/provision/locations/ (model: its default device.model). */
type ProvisionLocation = {
  id: number;
  project_id: number;
  name: string | null;
  project_type: string;
  model: string;
};

type Option = { value: number; label: string };

type ProvisionSettings = {
  model: string;
  /** Bundle id; '' while the server holds none (the config gets the fallback version). */
  firmware: string;
  sensors: string;
  interval_sec: string;
  pulldown_resistance: string;
  protective_earth: boolean;
  /** control.rpi of the config: the controller runs on a Raspberry Pi. */
  rpi: boolean;
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
  /** The config as a PNG QR code (data URI). */
  config_qr: string;
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
  rpi: false,
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
  const [showConfigQr, setShowConfigQr] = useState(false);
  const [loading, setLoading] = useState(false);

  // A new (or no) config: its QR code is generated again on request.
  useEffect(() => setShowConfigQr(false), [preview]);

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
        rpi: settings.rpi,
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

  const portalQrCode = (title: string, caption: string, code: QrCode) => (
    <figure className="m-0 text-center" {...repeatedTestId('device-provision-portal-qr', caption)}>
      <img src={code.image} alt={title} width={130} height={130} className="device-provision-qr" />
      <figcaption className="device-provision-caption">
        <strong>{title}</strong>
        <br />
        <code>{caption}</code>
      </figcaption>
    </figure>
  );

  const label = (text: string) => (
    <Form.Label className="device-provision-label text-muted mb-0">
      {text}
    </Form.Label>
  );

  // "v1.0.0 (FW: v1.6.1) · latest in stable" - the full bundle id on hover.
  const bundleOption = (bundle: FirmwareBundle) =>
    [
      bundleVersionLabel(bundle),
      bundle.latest_in.length
        ? t('provision_firmware_latest', { channels: bundle.latest_in.join(', ') })
        : bundle.channels.join(', '),
    ]
      .filter(Boolean)
      .join(' · ');

  const facts: [string, ReactNode][] = preview
    ? [
        ['Device hash', <code key="hash" data-testid="device-provision-hash">{preview.device_hash}</code>],
        [t('provision_model'), <code key="model">{preview.model}</code>],
        [
          t('provision_firmware'),
          <span key="firmware">
            <code>{preview.firmware_version}</code>
            {preview.firmware_bundle && <span className="text-muted ms-1">({preview.firmware_bundle})</span>}
          </span>,
        ],
        ['Location', `${location?.name || '-'} (project ${preview.project_id})`],
        [
          'URL',
          <code key="url" className="text-break">
            {preview.url}
          </code>,
        ],
        ['Token', <code key="token" data-testid="device-provision-token">{preview.token}</code>],
      ]
    : [];

  return (
    <PanelCard
      title={t('provision_add_title')}
      testId="device-provision"
      actions={
        <Button variant="link" size="sm" className="p-0" onClick={onClose} data-testid="device-provision-close">
          {t('provision_add_close')}
        </Button>
      }
    >
      <div className="device-provision-hint text-muted mb-2">
        {t('provision_add_hint')}
      </div>

      {locations === null ? (
        <div className="d-flex align-items-center gap-2 text-muted py-2" data-testid="device-provision-loading">
          <Spinner size="sm" animation="border" /> {t('provision_loading')}
        </div>
      ) : !location ? (
        <Alert variant="warning" className="mb-0" data-testid="device-provision-unavailable">
          {t('provision_location_unavailable')}
        </Alert>
      ) : (
        <>
          <Row className="g-2 align-items-end">
            <Col sm={6} lg={3}>
              <Form.Group controlId="provision-model">
                {label(t('provision_model'))}
                <Form.Select
                  size="sm"
                  value={settings.model}
                  onChange={(event) => updateSetting('model', event.target.value)}
                  data-testid="device-provision-model"
                >
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
            <Col sm={6} lg={3}>
              <Form.Group controlId="provision-firmware">
                {label(t('provision_firmware'))}
                {bundles.length === 0 ? (
                  // No bundle on the server: the config gets the built-in version.
                  <Form.Select size="sm" disabled value="" data-testid="device-provision-firmware">
                    <option value="">{t('provision_firmware_none', { version: firmwareFallback })}</option>
                  </Form.Select>
                ) : (
                  <Form.Select
                    size="sm"
                    value={settings.firmware}
                    title={settings.firmware || undefined}
                    onChange={(event) => updateSetting('firmware', event.target.value)}
                    data-testid="device-provision-firmware"
                  >
                    {bundles.map((bundle) => (
                      <option key={bundle.id} value={bundle.id} title={bundle.id}>
                        {bundleOption(bundle)}
                      </option>
                    ))}
                  </Form.Select>
                )}
              </Form.Group>
            </Col>
            <Col xs={6} sm={3} lg={2}>
              <Form.Group controlId="provision-sensors">
                {label('Sensors')}
                <Form.Control
                  size="sm"
                  type="number"
                  min={1}
                  value={settings.sensors}
                  onChange={(event) => updateSetting('sensors', event.target.value)}
                  data-testid="device-provision-sensors"
                />
              </Form.Group>
            </Col>
            <Col xs={6} sm={3} lg={2}>
              <Form.Group controlId="provision-interval">
                {label('Interval (sec)')}
                <Form.Control
                  size="sm"
                  type="number"
                  min={10}
                  max={86400}
                  value={settings.interval_sec}
                  onChange={(event) => updateSetting('interval_sec', event.target.value)}
                  data-testid="device-provision-interval"
                />
              </Form.Group>
            </Col>
            <Col sm={6} lg={2}>
              <Form.Group controlId="provision-resistance">
                {label('Pull-down')}
                <Form.Select
                  size="sm"
                  value={settings.pulldown_resistance}
                  onChange={(event) => updateSetting('pulldown_resistance', event.target.value)}
                  data-testid="device-provision-resistance"
                >
                  {resistances.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.value})
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col sm={6} lg={3}>
              <Form.Group controlId="provision-ssid">
                {label('WiFi SSID (optional)')}
                <Form.Control
                  size="sm"
                  value={settings.wifi_ssid}
                  onChange={(event) => updateSetting('wifi_ssid', event.target.value)}
                  data-testid="device-provision-wifi-ssid"
                />
              </Form.Group>
            </Col>
            <Col sm={6} lg={3}>
              <Form.Group controlId="provision-pwd">
                {label('WiFi password (optional)')}
                <Form.Control
                  size="sm"
                  type="password"
                  autoComplete="new-password"
                  value={settings.wifi_pwd}
                  onChange={(event) => updateSetting('wifi_pwd', event.target.value)}
                  data-testid="device-provision-wifi-pwd"
                />
              </Form.Group>
            </Col>
            <Col xs="auto" className="pb-1">
              <Form.Check
                type="switch"
                id="provision-protective-earth"
                label="Protective earth"
                className="small mb-0"
                checked={settings.protective_earth}
                onChange={(event) => updateSetting('protective_earth', event.target.checked)}
                data-testid="device-provision-protective-earth"
              />
            </Col>
            <Col xs="auto" className="pb-1">
              <Form.Check
                type="switch"
                id="provision-rpi"
                label="Raspberry Pi"
                className="small mb-0"
                checked={settings.rpi}
                onChange={(event) => updateSetting('rpi', event.target.checked)}
                data-testid="device-provision-rpi"
              />
            </Col>
            <Col xs="auto" className="ms-lg-auto">
              <Button
                size="sm"
                variant="primary"
                onClick={generate}
                disabled={loading || !settings.model}
                data-testid="device-provision-generate"
              >
                {loading && !preview ? (
                  <Spinner size="sm" animation="border" className="me-2" />
                ) : (
                  <FileEarmarkCode className="me-2" />
                )}
                Generate config
              </Button>
            </Col>
          </Row>

          {preview && (
            <div className="mt-3" data-testid="device-provision-preview">
              <div className="device-provision-facts" data-testid="device-provision-facts">
                {facts.map(([name, value]) => (
                  <div key={name} className="device-provision-fact">
                    <span className="text-muted me-2">{name}</span>
                    {value}
                  </div>
                ))}
              </div>

              <Row className="g-2 mb-2">
                <Col lg={9}>
                  <Form.Control
                    as="textarea"
                    readOnly
                    rows={14}
                    value={preview.config}
                    className="device-provision-config font-monospace"
                    onFocus={(event) => event.target.select()}
                    data-testid="device-provision-config"
                  />
                </Col>
                <Col lg={3}>
                  <div className="d-flex flex-wrap flex-lg-column align-items-center gap-2">
                    {portalQrCode('Setup portal Wi-Fi', preview.portal.wifi.ssid, preview.portal.wifi)}
                    {portalQrCode('Controller', preview.portal.frontend.url, preview.portal.frontend)}
                  </div>
                </Col>
              </Row>

              <div className="d-flex flex-wrap align-items-center gap-2">
                <Button size="sm" variant="outline-secondary" onClick={copyConfig} data-testid="device-provision-copy">
                  <Clipboard className="me-2" />
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => setShowConfigQr(true)}
                  disabled={showConfigQr}
                  data-testid="device-provision-show-config-qr"
                >
                  <QrCodeIcon className="me-2" />
                  Generate QR-Code
                </Button>
                <Button size="sm" variant="success" onClick={confirm} disabled={loading || confirmed} data-testid="device-provision-confirm">
                  {loading ? (
                    <Spinner size="sm" animation="border" className="me-2" />
                  ) : (
                    <CheckCircle className="me-2" />
                  )}
                  Confirm
                </Button>
                {confirmed ? (
                  <span className="device-provision-ready small" data-testid="device-provision-ready">
                    <CheckCircle className="me-1" />
                    Device <code>{preview.device_hash}</code> is created and linked to its location - it is ready to
                    send its data.
                  </span>
                ) : (
                  <span className="small text-muted" data-testid="device-provision-not-saved">Nothing is saved yet: the token only works once you confirm.</span>
                )}
              </div>

              {showConfigQr && (
                <figure className="mt-3 mb-0 text-center" data-testid="device-provision-config-qr">
                  <img
                    src={preview.config_qr}
                    alt={`Config ${preview.device_hash}`}
                    className="device-provision-qr device-provision-qr--config"
                  />
                  <figcaption className="device-provision-caption">
                    <strong>Config</strong> <code>{preview.device_hash}</code>
                  </figcaption>
                </figure>
              )}
            </div>
          )}
        </>
      )}
    </PanelCard>
  );
};

export default DeviceProvisionPanel;
