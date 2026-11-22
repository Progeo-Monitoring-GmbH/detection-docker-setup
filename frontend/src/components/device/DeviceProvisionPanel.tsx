import { useEffect, useState } from 'react';
import { Alert, Button, Spinner } from 'react-bootstrap';
import { CheckCircle, Clipboard, FileEarmarkCode, QrCode as QrCodeIcon } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showErrorBar, showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PanelCard from '../ui/kit/PanelCard';
import ConfigSectionCards, { type ConfigSection, maskedSecret } from './ConfigSectionCards';
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
  /** The optional router section: the login of the site's router. */
  router: boolean;
  router_user: string;
  router_pwd: string;
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
  router: false,
  router_user: '',
  router_pwd: '',
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
 * the config of a new smartex controller for `locationId`, one card per
 * section (ConfigSectionCards) - a card's pencil opens a small dialog to
 * change its values, a router section can be added. Generate the config
 * (device_hash + transfer token come from the backend) and confirm - the
 * device is then filed under the location and can send its samples.
 * `onCreated` gets the new device (the overview shows its test measurements).
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
  const [showConfig, setShowConfig] = useState(false);
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

  const generate = (next: ProvisionSettings = settings) => {
    setLoading(true);
    setPreview(null);
    setConfirmed(false);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/preview/',
      {
        location: locationId,
        model: asciiModel(next.model),
        // '': the backend's default bundle (or its fallback version without any).
        firmware: next.firmware,
        sensors: Number(next.sensors),
        interval_sec: Number(next.interval_sec),
        pulldown_resistance: Number(next.pulldown_resistance),
        protective_earth: next.protective_earth ? 1 : 0,
        rpi: next.rpi,
        wifi_ssid: next.wifi_ssid,
        wifi_pwd: next.wifi_pwd,
        router_user: next.router ? next.router_user : '',
        router_pwd: next.router ? next.router_pwd : '',
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

  /** A section's dialog was saved. A config on screen is stale now: it is
   * generated again - unless its device is already created (the next
   * "Generate config" starts a new one). */
  const applySettings = (patch: Partial<ProvisionSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (preview && !confirmed) {
      generate(next);
    } else {
      setPreview(null);
      setConfirmed(false);
    }
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
      <img src={code.image} alt={title} width={110} height={110} className="device-provision-qr" />
      <figcaption className="device-provision-caption">
        <strong>{title}</strong>
        <br />
        <code>{caption}</code>
      </figcaption>
    </figure>
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

  // What only the backend knows: shown once the config is generated.
  const generated = (value: string | undefined, testId?: string) =>
    value ? (
      <code data-testid={testId}>{value}</code>
    ) : (
      <span className="device-provision-pending">{t('provision_generated_later')}</span>
    );

  const resistanceLabel =
    resistances.find((option) => String(option.value) === settings.pulldown_resistance)?.label ?? '';
  const chosenBundle = bundles.find((bundle) => bundle.id === settings.firmware);

  const routerSection: ConfigSection = {
    name: 'router',
    tone: 'cyan',
    rows: [
      { key: 'user', value: settings.router_user },
      { key: 'pwd', value: maskedSecret(settings.router_pwd) },
    ],
    fields: [
      { key: 'user', kind: 'text', testId: 'device-provision-router-user' },
      { key: 'pwd', kind: 'password', testId: 'device-provision-router-pwd' },
    ],
    values: { user: settings.router_user, pwd: settings.router_pwd },
    // An empty section would not be written into the config.
    valid: (values) => String(values.user).trim() !== '' || String(values.pwd) !== '',
    onSave: (values) =>
      applySettings({ router: true, router_user: String(values.user).trim(), router_pwd: String(values.pwd) }),
    onRemove: () => applySettings({ router: false, router_user: '', router_pwd: '' }),
  };

  const sections: ConfigSection[] = [
    {
      name: 'wifi',
      tone: 'blue',
      rows: [
        { key: 'ssid', value: settings.wifi_ssid },
        { key: 'pwd', value: maskedSecret(settings.wifi_pwd) },
      ],
      fields: [
        { key: 'ssid', kind: 'text', testId: 'device-provision-wifi-ssid' },
        { key: 'pwd', kind: 'password', testId: 'device-provision-wifi-pwd' },
      ],
      values: { ssid: settings.wifi_ssid, pwd: settings.wifi_pwd },
      onSave: (values) => applySettings({ wifi_ssid: String(values.ssid).trim(), wifi_pwd: String(values.pwd) }),
    },
    ...(settings.router ? [routerSection] : []),
    {
      name: 'device',
      tone: 'teal',
      rows: [
        { key: 'model', value: settings.model },
        { key: 'project_id', value: location ? String(location.project_id) : '' },
        { key: 'device_hash', value: generated(preview?.device_hash, 'device-provision-hash') },
      ],
      fields: [
        {
          key: 'model',
          kind: 'select',
          testId: 'device-provision-model',
          // A default the list lacks stays selectable.
          options: [...(settings.model && !models.includes(settings.model) ? [settings.model] : []), ...models].map(
            (model) => ({ value: model, label: model }),
          ),
        },
      ],
      values: { model: settings.model },
      onSave: (values) => applySettings({ model: String(values.model) }),
    },
    {
      name: 'measurement',
      tone: 'purple',
      rows: [
        {
          key: 'pulldown_resistance',
          value: resistanceLabel ? `${resistanceLabel} (${settings.pulldown_resistance})` : settings.pulldown_resistance,
        },
        { key: 'interval_sec', value: settings.interval_sec },
        { key: 'sensors', value: settings.sensors },
        { key: 'protective_earth', value: settings.protective_earth ? '1' : '0' },
      ],
      fields: [
        {
          key: 'pulldown_resistance',
          kind: 'select',
          testId: 'device-provision-resistance',
          options: resistances.map((option) => ({
            value: String(option.value),
            label: `${option.label} (${option.value})`,
          })),
        },
        { key: 'interval_sec', kind: 'number', min: 10, max: 86400, testId: 'device-provision-interval' },
        { key: 'sensors', kind: 'number', min: 1, testId: 'device-provision-sensors' },
        { key: 'protective_earth', kind: 'switch', testId: 'device-provision-protective-earth' },
      ],
      values: {
        pulldown_resistance: settings.pulldown_resistance,
        interval_sec: settings.interval_sec,
        sensors: settings.sensors,
        protective_earth: settings.protective_earth,
      },
      onSave: (values) =>
        applySettings({
          pulldown_resistance: String(values.pulldown_resistance),
          interval_sec: String(values.interval_sec).trim(),
          sensors: String(values.sensors).trim(),
          protective_earth: values.protective_earth === true,
        }),
    },
    {
      name: 'control',
      tone: 'amber',
      rows: [
        { key: 'url', value: generated(preview?.url) },
        { key: 'token', value: generated(preview?.token, 'device-provision-token') },
        { key: 'rpi', value: settings.rpi ? 'true' : 'false' },
      ],
      fields: [{ key: 'rpi', kind: 'switch', testId: 'device-provision-rpi' }],
      values: { rpi: settings.rpi },
      onSave: (values) => applySettings({ rpi: values.rpi === true }),
    },
    {
      name: 'firmware',
      tone: 'green',
      rows: [
        {
          key: 'version',
          value:
            preview?.firmware_version ||
            chosenBundle?.firmware ||
            (bundles.length === 0 ? t('provision_firmware_none', { version: firmwareFallback }) : ''),
        },
        ...(bundles.length ? [{ key: 'bundle', value: preview?.firmware_bundle || settings.firmware }] : []),
      ],
      // No bundle on the server: the config gets the built-in version.
      fields: bundles.length
        ? [
            {
              key: 'bundle',
              kind: 'select',
              testId: 'device-provision-firmware',
              options: bundles.map((bundle) => ({ value: bundle.id, label: bundleOption(bundle), title: bundle.id })),
            },
          ]
        : [],
      values: { bundle: settings.firmware },
      onSave: (values) => applySettings({ firmware: String(values.bundle) }),
    },
    // The controller's setup network - the same for every device.
    ...(preview
      ? [
          {
            name: 'portal',
            tone: 'grey' as const,
            rows: [],
            body: (
              <div className="device-provision-portal">
                {portalQrCode('Setup portal Wi-Fi', preview.portal.wifi.ssid, preview.portal.wifi)}
                {portalQrCode('Controller', preview.portal.frontend.url, preview.portal.frontend)}
              </div>
            ),
          },
        ]
      : []),
  ];

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
          <ConfigSectionCards
            testId="device-provision-sections"
            sections={sections}
            addable={settings.router ? [] : [routerSection]}
            disabled={loading}
          />

          <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
            <Button
              size="sm"
              variant={preview ? 'outline-secondary' : 'primary'}
              onClick={() => generate()}
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
            {preview && (
              <>
                <Button size="sm" variant="outline-secondary" onClick={copyConfig} data-testid="device-provision-copy">
                  <Clipboard className="me-2" />
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => setShowConfig((shown) => !shown)}
                  data-testid="device-provision-show-config"
                >
                  <FileEarmarkCode className="me-2" />
                  {t(showConfig ? 'provision_config_hide' : 'provision_config_show')}
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
              </>
            )}
            {!preview ? (
              <span className="small text-muted">{t('provision_generate_hint')}</span>
            ) : confirmed ? (
              <span className="device-provision-ready small" data-testid="device-provision-ready">
                <CheckCircle className="me-1" />
                Device <code>{preview.device_hash}</code> is created and linked to its location - it is ready to
                send its data.
              </span>
            ) : (
              <span className="small text-muted" data-testid="device-provision-not-saved">Nothing is saved yet: the token only works once you confirm.</span>
            )}
          </div>

          {preview && (showConfig || showConfigQr) && (
            <div className="mt-2" data-testid="device-provision-preview">
              {showConfig && (
                <pre className="device-provision-config mb-0" data-testid="device-provision-config">
                  {preview.config}
                </pre>
              )}

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
