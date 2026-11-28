import { useEffect, useState } from 'react';
import { Alert, Button, Form, Spinner } from 'react-bootstrap';
import { CheckCircle, Clipboard, Download, FileEarmarkCode, QrCode as QrCodeIcon } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { staffFlags } from '../../main/access';
import axiosConfig from '../../axiosConfig';
import { showErrorBar, showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PanelCard from '../ui/kit/PanelCard';
import ConfigSectionCards, { type ConfigSection, type SectionValues, maskedSecret } from './ConfigSectionCards';
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
  /** Alarm threshold of the location in mV (M5: compared with the device's). */
  alarm_threshold?: number | null;
};

/** defaults.m5 of the locations endpoint (JSON object keys are strings). */
type M5Defaults = {
  sensors: number;
  interval_sec: number;
  poll_sec: number;
  threshold_mv: Record<string, number>;
  rs485_enabled?: boolean;
};

const DEFAULT_M5_MODEL = 'M5 AIN4';

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
  /** M5 only: threshold in mV (1..999, -1 = sensor off) and the command poll interval. */
  threshold_mv: string;
  /** The threshold was typed by hand: a new pulldown no longer resets it. */
  threshold_touched: boolean;
  poll_sec: string;
  /** M5 only: the RS485 climate sensors (XY-MD04) - by default into the M5's
   * project (its location's Klima tab), or a smartex io project of their own. */
  rs485_enabled: boolean;
  rs485_project_id: string;
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
  /** 'lua' (default) or 'm5' (config.py of the M5's MicroPython firmware). */
  config_format?: 'lua' | 'm5';
  config_filename?: string;
  /** The config as a PNG QR code (data URI). Lua: config.lua itself; M5: the
   *  compact config.py ("# progeo:m5-config:1") for the ProGeo flasher app. */
  config_qr?: string;
  /** M5 only: the text inside config_qr (the compact config.py). */
  config_qr_text?: string;
  signed: string;
  /** Lua only. */
  portal?: {
    wifi: QrCode & { ssid: string };
    frontend: QrCode & { url: string };
  };
};

export type ProvisionedDevice = { id: number; location: number; raw_hash: string; is_m5?: boolean };

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
  threshold_mv: '',
  threshold_touched: false,
  poll_sec: '300',
  rs485_enabled: false,
  rs485_project_id: '',
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
  const [m5Model, setM5Model] = useState(DEFAULT_M5_MODEL);
  const [m5Defaults, setM5Defaults] = useState<M5Defaults | null>(null);
  /** The location defaults of the Lua box (provision/locations): what leaving the M5 restores. */
  const [luaDefaults, setLuaDefaults] = useState<Partial<ProvisionSettings>>({});
  // The M5 (model and config type) is for staff only - the backend refuses it for anyone else.
  const isStaff = staffFlags(auth?.user).isStaffOrSuperuser;
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
        setM5Model(asciiModel(String(data.m5_model || DEFAULT_M5_MODEL)));
        setM5Defaults((data.defaults?.m5 || null) as M5Defaults | null);
        const defaults = data.defaults || {};
        setLuaDefaults({
          sensors: String(defaults.sensors ?? ''),
          interval_sec: String(defaults.interval_sec ?? ''),
          pulldown_resistance: String(defaults.pulldown_resistance ?? ''),
        });
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
  const isM5 = settings.model !== '' && settings.model === m5Model;

  /** M5: the threshold must be 1..999 mV - an empty field is never sent as 0. */
  const thresholdValid = (value: string) => /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 999;

  /** M5: with RS485 on, a climate project id of its own is a positive
   * integer - or empty: the M5's project (its location's Klima tab). */
  const rs485Valid = (value: ProvisionSettings) => {
    const project = value.rs485_project_id.trim();
    return !value.rs485_enabled || project === '' || (/^\d+$/.test(project) && Number(project) >= 1);
  };

  /** M5: the factory threshold of a pulldown (defaults.m5.threshold_mv has string keys). */
  const defaultThreshold = (pulldown: string) => {
    const value = m5Defaults?.threshold_mv?.[pulldown];
    return value == null ? '' : String(value);
  };

  /** A change of model or pulldown: the M5 starts from its own defaults. */
  const withM5Defaults = (previous: ProvisionSettings, next: ProvisionSettings): ProvisionSettings => {
    if (previous.model !== '' && previous.model === m5Model && next.model !== previous.model && next.model !== m5Model) {
      // Leaving the M5: its 4 sensors / 300 s must not stay on a Lua box.
      return {
        ...next,
        ...Object.fromEntries(Object.entries(luaDefaults).filter(([, value]) => value !== '')),
        protective_earth: false,
        rpi: false,
        router: false,
      };
    }
    if (next.model === '' || next.model !== m5Model || !m5Defaults) {
      return next;
    }
    const result = { ...next };
    if (previous.model !== next.model) {
      result.sensors = String(m5Defaults.sensors);
      result.interval_sec = String(m5Defaults.interval_sec);
      result.poll_sec = String(m5Defaults.poll_sec);
      result.rs485_enabled = m5Defaults.rs485_enabled ?? false;
      result.rs485_project_id = '';
      result.protective_earth = false;
      result.rpi = false;
      result.router = false;
      result.threshold_touched = false;
      if (result.pulldown_resistance === '8' || !(result.pulldown_resistance in m5Defaults.threshold_mv)) {
        result.pulldown_resistance = '136';
      }
    }
    if (!result.threshold_touched) {
      result.threshold_mv = defaultThreshold(result.pulldown_resistance);
    }
    return result;
  };

  // Another location: its own default model, and the old preview is stale.
  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
    if (location) {
      setSettings((current) =>
        withM5Defaults(current, { ...current, model: asciiModel(location.model || '') }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, location?.model, m5Defaults]);

  const generate = (next: ProvisionSettings = settings) => {
    if (next.model !== '' && next.model === m5Model && (!thresholdValid(next.threshold_mv) || !rs485Valid(next))) {
      return;
    }
    setLoading(true);
    setPreview(null);
    setConfirmed(false);
    const nextIsM5 = next.model !== '' && next.model === m5Model;
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/preview/',
      {
        config_format: nextIsM5 ? 'm5' : 'lua',
        ...(nextIsM5
          ? {
              threshold_mv: Number(next.threshold_mv),
              poll_sec: Number(next.poll_sec),
              rs485_enabled: next.rs485_enabled,
              ...(next.rs485_project_id.trim() !== '' ? { rs485_project_id: Number(next.rs485_project_id) } : {}),
            }
          : {}),
        location: locationId,
        model: asciiModel(next.model),
        // '': the backend's default bundle (or its fallback version without any).
        firmware: next.firmware,
        sensors: Number(next.sensors),
        interval_sec: Number(next.interval_sec),
        pulldown_resistance: Number(next.pulldown_resistance),
        protective_earth: next.protective_earth && !nextIsM5 ? 1 : 0,
        rpi: nextIsM5 ? false : next.rpi,
        wifi_ssid: nextIsM5 ? '' : next.wifi_ssid,
        wifi_pwd: nextIsM5 ? '' : next.wifi_pwd,
        router_user: next.router && !nextIsM5 ? next.router_user : '',
        router_pwd: next.router && !nextIsM5 ? next.router_pwd : '',
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
    const next = withM5Defaults(settings, { ...settings, ...patch });
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
            is_m5: preview.config_format === 'm5',
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

  /** The M5 config is a file (config.py) for its MicroPython firmware. */
  const downloadConfig = () => {
    if (!preview) {
      return;
    }
    const url = URL.createObjectURL(new Blob([preview.config], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = preview.config_filename || 'config.py';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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

  // The device types (models) on offer: the location's own first - even one
  // the list lacks - then the others; the M5 for staff only.
  const locationModel = asciiModel(location?.model || '');
  const modelOptions = [
    ...new Set([
      ...(locationModel ? [locationModel] : []),
      ...(settings.model ? [settings.model] : []),
      ...models.filter((model) => isStaff || model !== m5Model),
    ]),
  ];

  const m5Resistances = resistances.filter((option) => option.value !== 8);
  const locationThreshold = location?.alarm_threshold ?? null;
  const thresholdInvalid = isM5 && !thresholdValid(settings.threshold_mv);
  const thresholdMismatch =
    isM5 && !thresholdInvalid && locationThreshold != null && Number(settings.threshold_mv) !== locationThreshold;

  const wifiSection: ConfigSection = {
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
  };

  const firmwareSection: ConfigSection = {
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
  };

  const sections: ConfigSection[] = [
    ...(isM5 ? [] : [wifiSection]),
    ...(settings.router && !isM5 ? [routerSection] : []),
    {
      name: 'device',
      tone: 'teal',
      rows: [
        { key: 'model', value: settings.model },
        { key: 'project_id', value: location ? String(location.project_id) : '' },
        { key: 'device_hash', value: generated(preview?.device_hash, 'device-provision-hash') },
        {
          key: 'config_format',
          label: t('provision_config_format'),
          value: (
            <span data-testid="device-provision-config-format">
              {t(isM5 ? 'provision_config_format_m5' : 'provision_config_format_lua')}
            </span>
          ),
        },
      ],
      fields: [
        {
          key: 'config_format',
          label: t('provision_config_format'),
          kind: 'select',
          testId: 'device-provision-config-format-select',
          options: [
            { value: 'lua', label: t('provision_config_format_lua') },
            ...(isStaff ? [{ value: 'm5', label: t('provision_config_format_m5') }] : []),
          ],
        },
      ],
      // The model itself: the "Gerätetyp" select above the cards.
      values: { config_format: isM5 ? 'm5' : 'lua' },
      onSave: (values) => {
        const format = String(values.config_format);
        if (format === (isM5 ? 'm5' : 'lua')) {
          return;
        }
        if (format === 'm5') {
          applySettings({ model: m5Model });
        } else {
          const own = asciiModel(location?.model || '');
          applySettings({ model: own && own !== m5Model ? own : (models.find((name) => name !== m5Model) ?? own) });
        }
      },
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
        ...(isM5
          ? [
              {
                key: 'threshold_mv',
                label: t('provision_threshold_mv'),
                value: <span data-testid="device-provision-threshold">{settings.threshold_mv}</span>,
              },
              { key: 'poll_sec', label: t('provision_poll_sec'), value: settings.poll_sec },
            ]
          : [
              { key: 'sensors', value: settings.sensors },
              { key: 'protective_earth', value: settings.protective_earth ? '1' : '0' },
            ]),
      ],
      fields: [
        {
          key: 'pulldown_resistance',
          kind: 'select',
          testId: 'device-provision-resistance',
          options: (isM5 ? m5Resistances : resistances).map((option) => ({
            value: String(option.value),
            label: `${option.label} (${option.value})`,
          })),
        },
        { key: 'interval_sec', kind: 'number', min: 10, max: 86400, testId: 'device-provision-interval' },
        ...(isM5
          ? [
              { key: 'threshold_mv', label: t('provision_threshold_mv'), kind: 'number' as const, min: 1, max: 999, testId: 'device-provision-threshold-input' },
              { key: 'poll_sec', label: t('provision_poll_sec'), kind: 'number' as const, min: 60, max: 86400, testId: 'device-provision-poll' },
            ]
          : [
              { key: 'sensors', kind: 'number' as const, min: 1, testId: 'device-provision-sensors' },
              { key: 'protective_earth', kind: 'switch' as const, testId: 'device-provision-protective-earth' },
            ]),
      ],
      values: {
        pulldown_resistance: settings.pulldown_resistance,
        interval_sec: settings.interval_sec,
        sensors: settings.sensors,
        protective_earth: settings.protective_earth,
        threshold_mv: settings.threshold_mv,
        poll_sec: settings.poll_sec,
      },
      onSave: (values) =>
        applySettings({
          pulldown_resistance: String(values.pulldown_resistance),
          interval_sec: String(values.interval_sec).trim(),
          ...(isM5
            ? {
                poll_sec: String(values.poll_sec).trim(),
                // A value changed by hand is kept when the pulldown changes.
                ...(String(values.threshold_mv).trim() !== settings.threshold_mv
                  ? { threshold_mv: String(values.threshold_mv).trim(), threshold_touched: true }
                  : {}),
              }
            : {
                sensors: String(values.sensors).trim(),
                protective_earth: values.protective_earth === true,
              }),
        }),
    },
    ...(isM5
      ? [
          {
            name: 'rs485',
            title: t('provision_rs485_title'),
            tone: 'green' as const,
            rows: [
              {
                key: 'rs485_enabled',
                label: t('provision_rs485_enabled'),
                value: settings.rs485_enabled ? 'true' : 'false',
              },
              ...(settings.rs485_enabled
                ? [
                    {
                      key: 'rs485_project_id',
                      label: t('provision_rs485_project_id'),
                      // Empty: the climate values go to the M5's own object.
                      value: settings.rs485_project_id.trim() || t('provision_rs485_project_default'),
                    },
                  ]
                : []),
            ],
            fields: [
              {
                key: 'rs485_enabled',
                label: t('provision_rs485_enabled'),
                kind: 'switch' as const,
                testId: 'device-provision-rs485-enabled',
              },
              // Shown while enabled (the dialog's draft decides, see ConfigSectionCards.showWhen).
              {
                key: 'rs485_project_id',
                label: t('provision_rs485_project_id'),
                kind: 'number' as const,
                min: 1,
                optional: true,
                hint: t('provision_rs485_project_hint'),
                testId: 'device-provision-rs485-project',
                showWhen: 'rs485_enabled',
              },
            ],
            values: {
              rs485_enabled: settings.rs485_enabled,
              rs485_project_id: settings.rs485_project_id,
            },
            onSave: (values: SectionValues) =>
              applySettings({
                rs485_enabled: values.rs485_enabled === true,
                rs485_project_id: String(values.rs485_project_id ?? '').trim(),
              }),
          },
        ]
      : []),
    {
      name: 'control',
      tone: 'amber',
      rows: [
        { key: 'url', value: generated(preview?.url) },
        { key: 'token', value: generated(preview?.token, 'device-provision-token') },
        ...(isM5 ? [] : [{ key: 'rpi', value: settings.rpi ? 'true' : 'false' }]),
      ],
      fields: isM5 ? [] : [{ key: 'rpi', kind: 'switch', testId: 'device-provision-rpi' }],
      values: { rpi: settings.rpi },
      onSave: (values) => applySettings({ rpi: values.rpi === true }),
    },
    ...(isM5 ? [] : [firmwareSection]),
    // The controller's setup network - the same for every device.
    ...(preview?.portal
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
          {/* Preselected with the location's type - any other device can be added too. */}
          <Form.Group controlId="device-provision-model" className="device-provision-type">
            <Form.Label className="device-provision-type-label">{t('provision_device_type')}</Form.Label>
            <Form.Select
              value={settings.model}
              onChange={(event) => applySettings({ model: event.target.value })}
              disabled={loading}
              data-testid="device-provision-model"
            >
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model === locationModel ? t('provision_device_type_location', { model }) : model}
                </option>
              ))}
            </Form.Select>
            <Form.Text className="device-provision-type-hint">
              {t('provision_device_type_hint')}
            </Form.Text>
          </Form.Group>

          <ConfigSectionCards
            testId="device-provision-sections"
            sections={sections}
            addable={settings.router || isM5 ? [] : [routerSection]}
            disabled={loading}
          />

          {isM5 && locationThreshold != null && (
            <div className="small text-muted mt-2" data-testid="device-provision-threshold-location">
              {t('provision_threshold_location', { value: locationThreshold })}
            </div>
          )}
          {thresholdInvalid && (
            <Alert variant="danger" className="mt-2 mb-0 py-1 small" data-testid="device-provision-threshold-invalid">
              {t('provision_threshold_invalid')}
            </Alert>
          )}
          {thresholdMismatch && (
            <Alert variant="warning" className="mt-2 mb-0 py-1 small" data-testid="device-provision-threshold-mismatch">
              {t('provision_threshold_mismatch', { threshold: settings.threshold_mv, location: locationThreshold })}
            </Alert>
          )}

          <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
            <Button
              size="sm"
              variant={preview ? 'outline-secondary' : 'primary'}
              onClick={() => generate()}
              disabled={loading || !settings.model || (isM5 && (!thresholdValid(settings.threshold_mv) || !rs485Valid(settings)))}
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
                {preview.config_format === 'm5' && (
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    onClick={downloadConfig}
                    data-testid="device-provision-download-config"
                  >
                    <Download className="me-2" />
                    {t('provision_download_config')}
                  </Button>
                )}
                {preview.config_qr && (
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
                )}
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

              {showConfigQr && preview.config_qr && (
                <figure className="mt-3 mb-0 text-center" data-testid="device-provision-config-qr">
                  <img
                    src={preview.config_qr}
                    alt={`Config ${preview.device_hash}`}
                    className="device-provision-qr device-provision-qr--config"
                  />
                  <figcaption className="device-provision-caption">
                    <strong>Config</strong> <code>{preview.device_hash}</code>
                    {preview.config_format === 'm5' && (
                      <div className="small text-muted" data-testid="device-provision-config-qr-m5-hint">
                        {t('provision_m5_qr_caption')}
                      </div>
                    )}
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
