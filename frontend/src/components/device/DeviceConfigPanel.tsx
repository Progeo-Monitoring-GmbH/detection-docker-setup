import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import axiosConfig from '../../axiosConfig';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PillButton from '../ui/kit/PillButton';
import LabeledInput from '../ui/kit/LabeledInput';
import SegmentedControl from '../ui/kit/SegmentedControl';

/** The ProgeoDevice fields the config file is seeded from. */
export type ConfigDevice = {
  id: number;
  raw_hash?: string | null;
  project_id?: number | string | null;
  device_ip?: string | null;
  data_interval?: number | null;
  pull_resistance?: number | null;
};

type DeviceConfigForm = {
  wifi_ssid: string;
  wifi_pwd: string;
  device_model: string;
  device_version: string;
  device_project_id: string;
  device_hash: string;
  measurement_interval_sec: number;
  measurement_sensors: number;
  measurement_protective_earth: number;
  measurement_pulldown_resistance: number;
};

const CONFIG_PATH = 'config/device_config.lua';

// The backend middleware currently resolves every request to account 1
// (progeo/middlewares.py), and the frontend has no account id of its own.
const QR_ACCOUNT_ID = 1;

const INTERVAL_OPTIONS = [
  { value: 300, label: '5min' },
  { value: 600, label: '10min' },
  { value: 900, label: '15min' },
  { value: 1800, label: '30min' },
  { value: 3600, label: '1h' },
  { value: 7200, label: '2h' },
  { value: 14400, label: '4h' },
  { value: 28800, label: '8h' },
  { value: 43200, label: '12h' },
  { value: 86400, label: '24h' },
];

/** ProgeoDevice.Resistance choices (pulldown_resistance in the file). */
const RESISTANCE_OPTIONS = [
  { value: 136, labelKey: 'einstell_resistance_100k' },
  { value: 72, labelKey: 'einstell_resistance_10k' },
  { value: 40, labelKey: 'einstell_resistance_1k' },
  { value: 24, labelKey: 'einstell_resistance_100' },
  { value: 8, labelKey: 'einstell_resistance_off' },
];

const initialForm = (
  device: ConfigDevice,
  peSwitched: boolean,
): DeviceConfigForm => ({
  wifi_ssid: '',
  wifi_pwd: '',
  device_model: 'smart',
  device_version: '',
  device_project_id: device.project_id != null ? String(device.project_id) : '',
  device_hash: device.raw_hash || '',
  measurement_interval_sec: device.data_interval || 3600,
  measurement_sensors: 16,
  measurement_protective_earth: peSwitched ? 1 : 0,
  measurement_pulldown_resistance: device.pull_resistance ?? 136,
});

const sectionContent = (lua: string, section: string) => {
  const match = lua.match(
    new RegExp(`${section}\\s*=\\s*\\{([\\s\\S]*?)\\}`, 'i'),
  );
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

const parseConfigContent = (
  lua: string,
  current: DeviceConfigForm,
): DeviceConfigForm => {
  const wifi = sectionContent(lua, 'wifi');
  const device = sectionContent(lua, 'device');
  const measurement = sectionContent(lua, 'measurement');

  return {
    wifi_ssid: getStringField(wifi, 'ssid') || current.wifi_ssid,
    wifi_pwd: getStringField(wifi, 'pwd') || current.wifi_pwd,
    device_model: getStringField(device, 'model') || current.device_model,
    device_version: getStringField(device, 'version') || current.device_version,
    device_project_id:
      getStringField(device, 'project_id') || current.device_project_id,
    device_hash: getStringField(device, 'device_hash') || current.device_hash,
    measurement_interval_sec: getNumberField(
      measurement,
      'interval_sec',
      current.measurement_interval_sec,
    ),
    measurement_sensors: getNumberField(
      measurement,
      'sensors',
      current.measurement_sensors,
    ),
    measurement_protective_earth: getNumberField(
      measurement,
      'protective_earth',
      current.measurement_protective_earth,
    ),
    measurement_pulldown_resistance: getNumberField(
      measurement,
      'pulldown_resistance',
      current.measurement_pulldown_resistance,
    ),
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
    pulldown_resistance = ${config.measurement_pulldown_resistance},
    interval_sec = ${config.measurement_interval_sec},
    sensors = ${config.measurement_sensors},
    protective_earth = ${config.measurement_protective_earth}
  }
}
`;

const fieldLabelStyle = {
  fontSize: 11,
  letterSpacing: '.07em',
  textTransform: 'uppercase' as const,
  color: '#8B8383',
  fontWeight: 500,
};

const selectStyle = {
  height: 40,
  border: 'none',
  borderRadius: 11,
  background: 'var(--progeo-surface)',
  boxShadow: '0 1px 4px rgba(11,54,89,.09)',
  padding: '0 13px',
  fontFamily: 'inherit',
  fontSize: 14,
  color: 'var(--progeo-blue)',
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
  gap: '14px 18px',
};

type DeviceConfigPanelProps = {
  device: ConfigDevice;
  /** Upload is gated by module_devices_edit on the backend. */
  canEdit: boolean;
  /** The device's location; PE geschaltet is ProgeoLocation.pe_geschaltet. */
  locationId: number | string;
  peSwitched: boolean;
  /** Called after ProgeoDevice.pull_resistance was saved. */
  onPullResistanceSaved?: (value: number) => void;
  /** Called after ProgeoLocation.pe_geschaltet was saved. */
  onPeSwitchedSaved?: (value: boolean) => void;
};

/**
 * Reads/writes the device's config/device_config.lua (formerly the
 * standalone /device/:id/update page).
 *
 * Dämpfungswiderstand and PE geschaltet are also stored in the database
 * (ProgeoDevice.pull_resistance, ProgeoLocation.pe_geschaltet): changing
 * them saves that field and immediately sends the updated config to the
 * device - but only once the config was loaded from it, so an untouched
 * default form (empty WiFi etc.) is never pushed by accident.
 */
const DeviceConfigPanel = ({
  device,
  canEdit,
  locationId,
  peSwitched,
  onPullResistanceSaved,
  onPeSwitchedSaved,
}: DeviceConfigPanelProps) => {
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [form, setForm] = useState<DeviceConfigForm>(() =>
    initialForm(device, peSwitched),
  );
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const content = toLuaConfig(form);

  const setField = (name: keyof DeviceConfigForm, value: string | number) =>
    setForm((previous) => ({ ...previous, [name]: value }));

  // `announce` is off for the automatic load on open: a success toast every
  // time the panel is expanded would be noise. Failures are always shown.
  const handleLoad = async (announce = true) => {
    try {
      setLoading(true);
      axiosConfig.updateToken();
      const response = await axiosConfig.holder.get(
        `/v1/device/${device.id}/config/download/`,
        { params: { path: CONFIG_PATH } },
      );
      setForm((previous) =>
        parseConfigContent(response?.data?.content || '', previous),
      );
      setLoaded(true);
      if (announce) {
        showSuccessBar(enqueueSnackbar, t('devcfg_loaded'));
      }
    } catch (error: any) {
      showRequestError(enqueueSnackbar, 'Could not load config', error);
    } finally {
      setLoading(false);
    }
  };

  // The panel is mounted when "show device configuration" is clicked, so
  // this reads the file from the device on every open. The ref keeps
  // StrictMode's double effect run from asking the device twice.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current) {
      return;
    }
    autoLoaded.current = true;
    void handleLoad(false);
    // Only on open - not when the device prop refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadConfig = async (config: DeviceConfigForm) => {
    try {
      setSaving(true);
      axiosConfig.updateToken();
      await axiosConfig.holder.post(`/v1/device/${device.id}/config/upload/`, {
        path: CONFIG_PATH,
        content: toLuaConfig(config),
      });
      showSuccessBar(enqueueSnackbar, t('devcfg_saved'));
    } catch (error: any) {
      showRequestError(enqueueSnackbar, 'Could not save config', error);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => uploadConfig(form);

  // Saves the database field, then pushes the changed config to the device.
  const changeStoredSetting = async (
    patch: Partial<DeviceConfigForm>,
    saveField: () => Promise<unknown>,
    onSaved: () => void,
  ) => {
    const previous = form;
    const next = { ...form, ...patch };
    setForm(next);
    try {
      setSaving(true);
      axiosConfig.updateToken();
      await saveField();
      onSaved();
    } catch (error: any) {
      setForm(previous);
      showRequestError(enqueueSnackbar, 'Could not save', error);
      return;
    } finally {
      setSaving(false);
    }
    if (loaded) {
      await uploadConfig(next);
    } else {
      showSuccessBar(enqueueSnackbar, t('devcfg_saved_not_sent'));
    }
  };

  const changePullResistance = (value: number) =>
    changeStoredSetting(
      { measurement_pulldown_resistance: value },
      () =>
        axiosConfig.holder.patch(`/v1/device/${device.id}/`, {
          pull_resistance: value,
        }),
      () => onPullResistanceSaved?.(value),
    );

  const changePeSwitched = (value: boolean) =>
    changeStoredSetting(
      { measurement_protective_earth: value ? 1 : 0 },
      () =>
        axiosConfig.holder.patch(`/v1/location/${locationId}/`, {
          pe_geschaltet: value,
        }),
      () => onPeSwitchedSaved?.(value),
    );

  const busy = loading || saving;

  const textField = (name: keyof DeviceConfigForm, labelKey: string) => (
    <LabeledInput
      label={t(labelKey)}
      value={String(form[name])}
      readOnly={!canEdit}
      onChange={(value) => setField(name, value)}
    />
  );

  const numberField = (name: keyof DeviceConfigForm, labelKey: string) => (
    <LabeledInput
      type="number"
      label={t(labelKey)}
      value={String(form[name])}
      readOnly={!canEdit}
      onChange={(value) => setField(name, Number(value) || 0)}
    />
  );

  return (
    <div
      style={{
        background: 'var(--progeo-track-soft)',
        borderRadius: 11,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={gridStyle}>
        <LabeledInput
          label={t('devcfg_device_ip')}
          value={device.device_ip || ''}
          readOnly
        />
        {textField('wifi_ssid', 'devcfg_wifi_ssid')}
        {textField('wifi_pwd', 'devcfg_wifi_pwd')}
        {textField('device_model', 'devcfg_model')}
        {textField('device_version', 'devcfg_version')}
        {textField('device_project_id', 'devcfg_project_id')}
        {textField('device_hash', 'devcfg_hash')}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabelStyle}>{t('devcfg_interval')}</span>
          <select
            value={form.measurement_interval_sec}
            disabled={!canEdit}
            onChange={(event) =>
              setField('measurement_interval_sec', Number(event.target.value))
            }
            style={selectStyle}
          >
            {INTERVAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {numberField('measurement_sensors', 'devcfg_sensors')}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={fieldLabelStyle}>{t('einstell_resistance')}</span>
          <select
            value={form.measurement_pulldown_resistance}
            disabled={!canEdit || busy}
            onChange={(event) =>
              void changePullResistance(Number(event.target.value))
            }
            style={selectStyle}
          >
            {/* A value on the device outside the known choices stays visible. */}
            {!RESISTANCE_OPTIONS.some(
              (option) => option.value === form.measurement_pulldown_resistance,
            ) && (
              <option value={form.measurement_pulldown_resistance}>
                {form.measurement_pulldown_resistance}
              </option>
            )}
            {RESISTANCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>
            {t('einstell_pe_geschaltet')}
          </div>
          <div style={{ fontSize: 12, color: '#8B8383', marginTop: 2 }}>
            {t('einstell_pe_geschaltet_hint')}
          </div>
        </div>
        <SegmentedControl
          options={[
            { value: 'ja', label: t('einstell_yes') },
            { value: 'nein', label: t('einstell_no') },
          ]}
          value={form.measurement_protective_earth ? 'ja' : 'nein'}
          onChange={
            canEdit && !busy
              ? (value) => void changePeSwitched(value === 'ja')
              : () => {}
          }
        />
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={fieldLabelStyle}>{t('devcfg_preview')}</span>
        <textarea
          rows={14}
          value={content}
          readOnly
          style={{
            border: 'none',
            borderRadius: 11,
            background: 'var(--progeo-surface)',
            padding: '10px 13px',
            fontFamily: 'monospace',
            fontSize: 12.5,
            color: 'var(--progeo-blue)',
            resize: 'vertical',
          }}
        />
      </label>

      <div
        style={{
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <PillButton
          variant="ghost"
          label={loading ? t('devcfg_loading') : t('devcfg_load')}
          onClick={() => handleLoad()}
          disabled={busy}
        />
        {canEdit && (
          <PillButton
            label={saving ? t('devcfg_saving') : t('devcfg_save')}
            onClick={handleSave}
            disabled={busy}
          />
        )}
        <Link
          to={`/setup/${QR_ACCOUNT_ID}/controller/qrcodes/`}
          target="_blank"
          rel="noopener"
          style={{
            marginLeft: 'auto',
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--progeo-orange)',
          }}
        >
          {t('devcfg_qrcodes')}
        </Link>
      </div>
    </div>
  );
};

export default DeviceConfigPanel;
