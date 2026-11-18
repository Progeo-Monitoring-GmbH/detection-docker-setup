import { useCallback, useEffect, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import axiosConfig from '../../axiosConfig';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PillButton from '../ui/kit/PillButton';
import LabeledInput from '../ui/kit/LabeledInput';
import SegmentedControl from '../ui/kit/SegmentedControl';
import { INTERVAL_OPTIONS, RESISTANCE_OPTIONS } from './deviceParams';
import { childTestId } from '../../testIds';
import './LegacyGprsConfigPanel.css';

/** The answer's interval has 4 digits (seconds). */
export const LEGACY_MAX_INTERVAL = 9999;

type LegacyValues = {
  interval: number | null;
  pull_resistance: number | null;
  sensor_count: number | null;
  pe: boolean | null;
  main_interval: number | null;
};

export type LegacyConfig = {
  script: string;
  role: 'main' | 'second';
  project_id: number;
  second_project_id: number | null;
  editable: Record<
    'interval' | 'pull_resistance' | 'sensor_count' | 'pe',
    boolean
  >;
  values: LegacyValues;
  reply: string;
  fields: {
    pd: string;
    interval: number | null;
    reset: string;
    sensors: number | null;
    earth: number | null;
  } | null;
  answered: boolean;
  missing: Record<string, string[]>;
};

type Form = {
  interval: number;
  pull_resistance: number;
  sensor_count: string;
  pe: boolean;
};

const toForm = (values: LegacyValues): Form => ({
  interval: values.interval ?? 1800,
  pull_resistance: values.pull_resistance ?? 136,
  sensor_count: values.sensor_count != null ? String(values.sensor_count) : '',
  pe: Boolean(values.pe),
});

/** The interval choices that fit into the answer, plus the current value. */
export const legacyIntervalOptions = (current: number) => {
  const options = INTERVAL_OPTIONS.filter(
    (option) => option.value <= LEGACY_MAX_INTERVAL,
  );
  return options.some((option) => option.value === current)
    ? options
    : [{ value: current, label: `${current} s` }, ...options];
};

/** The changed editable values - only those are sent. */
export const changedValues = (config: LegacyConfig, form: Form) => {
  const changes: Record<string, number | boolean> = {};
  const { editable, values } = config;
  if (editable.interval && form.interval !== values.interval) {
    changes.interval = form.interval;
  }
  if (
    editable.pull_resistance &&
    form.pull_resistance !== values.pull_resistance
  ) {
    changes.pull_resistance = form.pull_resistance;
  }
  const sensors = Number(form.sensor_count);
  if (
    editable.sensor_count &&
    form.sensor_count !== '' &&
    sensors !== values.sensor_count
  ) {
    changes.sensor_count = sensors;
  }
  if (editable.pe && form.pe !== Boolean(values.pe)) {
    changes.pe = form.pe;
  }
  return changes;
};

type LegacyGprsConfigPanelProps = {
  deviceId: number;
  /** device ids are only unique within one project database. */
  locationId: number | string;
  /** Saving is gated by module_devices_edit on the backend. */
  canEdit: boolean;
  testId?: string;
};

/**
 * The configuration of a legacy GPRS controller (gprs_<project>.php): it
 * gets interval, pulldown, sensor count and PE in the answer to its next
 * transmission (backend: progeo/v1/legacy/gprs_config.py), so saving here
 * is all it takes - no file on the device.
 */
const LegacyGprsConfigPanel = ({
  deviceId,
  locationId,
  canEdit,
  testId = 'legacy-config',
}: LegacyGprsConfigPanelProps) => {
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [config, setConfig] = useState<LegacyConfig | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const url = `/v1/device/${deviceId}/legacy-config/`;

  const apply = (data: LegacyConfig) => {
    setConfig(data);
    setForm(toForm(data.values));
  };

  const fetchConfig = useCallback(() => {
    axiosConfig.updateToken();
    return axiosConfig.holder.get(url, { params: { location: locationId } });
  }, [url, locationId]);

  // The reload button.
  const load = async () => {
    try {
      apply((await fetchConfig()).data as LegacyConfig);
    } catch (error: any) {
      showRequestError(enqueueSnackbar, t('legacycfg_load_failed'), error);
    }
  };

  // On open, and for another device - an answer for the previous one is dropped.
  useEffect(() => {
    let current = true;
    fetchConfig().then(
      (response) => {
        if (current) {
          const data = response.data as LegacyConfig;
          setConfig(data);
          setForm(toForm(data.values));
        }
      },
      (error) =>
        current &&
        showRequestError(enqueueSnackbar, t('legacycfg_load_failed'), error),
    );
    return () => {
      current = false;
    };
  }, [fetchConfig, enqueueSnackbar, t]);

  if (!config || !form) {
    return (
      <div
        className="legacy-config legacy-config--loading"
        data-testid={testId}
      >
        {t('legacycfg_loading')}
      </div>
    );
  }

  const changes = changedValues(config, form);
  const dirty = Object.keys(changes).length > 0;
  const busy = saving || !canEdit;

  const save = async () => {
    try {
      setSaving(true);
      axiosConfig.updateToken();
      // Refused values come back as 400 with a reason (shown by the catch).
      const response = await axiosConfig.holder.post(
        `${url}?location=${locationId}`,
        changes,
      );
      apply(response.data as LegacyConfig);
      showSuccessBar(enqueueSnackbar, t('legacycfg_saved'));
    } catch (error: any) {
      showRequestError(enqueueSnackbar, t('legacycfg_save_failed'), error);
    } finally {
      setSaving(false);
    }
  };

  const setField = <K extends keyof Form>(name: K, value: Form[K]) =>
    setForm((previous) =>
      previous ? { ...previous, [name]: value } : previous,
    );

  const missing = Object.entries(config.missing)
    .map(
      ([project, fields]) =>
        `${project}: ${fields.map((field) => t(`legacycfg_field_${field}`)).join(', ')}`,
    )
    .join('; ');

  return (
    <div
      className="legacy-config"
      data-testid={testId}
      data-test-key={deviceId}
    >
      <div className="legacy-config-head">
        <span
          className="legacy-config-script"
          data-testid={childTestId(testId, 'script')}
        >
          {config.script}
        </span>
        {config.role === 'second' && (
          <span
            className="legacy-config-note"
            data-testid={childTestId(testId, 'second')}
          >
            {t('legacycfg_second_of', {
              project: config.project_id,
              interval: config.values.main_interval ?? '?',
            })}
          </span>
        )}
      </div>

      <div className="legacy-config-grid">
        {config.editable.interval && (
          <label className="legacy-config-field">
            <span className="progeo-field-label">
              {t('legacycfg_interval')}
            </span>
            <select
              value={form.interval}
              disabled={busy}
              onChange={(event) =>
                setField('interval', Number(event.target.value))
              }
              className="legacy-config-select"
              data-testid={childTestId(testId, 'interval')}
            >
              {legacyIntervalOptions(form.interval).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="legacy-config-field">
          <span className="progeo-field-label">{t('einstell_resistance')}</span>
          <select
            value={form.pull_resistance}
            disabled={busy}
            onChange={(event) =>
              setField('pull_resistance', Number(event.target.value))
            }
            className="legacy-config-select"
            data-testid={childTestId(testId, 'resistance')}
          >
            {RESISTANCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <LabeledInput
          type="number"
          label={t('legacycfg_sensors')}
          value={form.sensor_count}
          readOnly={busy}
          onChange={(value) =>
            setField('sensor_count', value.replace(/\D/g, '').slice(0, 3))
          }
          testId={childTestId(testId, 'sensors')}
        />
      </div>

      {config.editable.pe && (
        <div className="legacy-config-switch">
          <div className="legacy-config-switch-title">
            {t('einstell_pe_geschaltet')}
          </div>
          <SegmentedControl
            options={[
              { value: 'ja', label: t('einstell_yes') },
              { value: 'nein', label: t('einstell_no') },
            ]}
            value={form.pe ? 'ja' : 'nein'}
            disabled={busy}
            onChange={(value) => setField('pe', value === 'ja')}
            testId={childTestId(testId, 'pe')}
          />
        </div>
      )}

      <div className="legacy-config-reply">
        <span className="progeo-field-label">{t('legacycfg_reply')}</span>
        {config.answered ? (
          <>
            <code
              className="legacy-config-reply-text"
              data-testid={childTestId(testId, 'reply')}
            >
              {config.reply.trim()}
            </code>
            {config.fields && (
              <span
                className="legacy-config-note"
                data-testid={childTestId(testId, 'fields')}
              >
                {t('legacycfg_fields', {
                  pd: config.fields.pd,
                  interval: config.fields.interval ?? '-',
                  sensors: config.fields.sensors ?? '-',
                  earth: config.fields.earth ?? '-',
                })}
              </span>
            )}
          </>
        ) : (
          <span
            className="legacy-config-warning"
            data-testid={childTestId(testId, 'not-answered')}
          >
            {t('legacycfg_not_answered', { fields: missing })}
          </span>
        )}
        <span className="legacy-config-note">{t('legacycfg_reply_hint')}</span>
      </div>

      <div className="legacy-config-actions">
        <PillButton
          variant="ghost"
          label={t('legacycfg_reload')}
          onClick={() => void load()}
          disabled={saving}
          testId={childTestId(testId, 'reload')}
        />
        {canEdit && (
          <PillButton
            label={saving ? t('legacycfg_saving') : t('legacycfg_save')}
            onClick={() => void save()}
            disabled={saving || !dirty}
            testId={childTestId(testId, 'save')}
          />
        )}
      </div>
    </div>
  );
};

export default LegacyGprsConfigPanel;
