import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PillButton from '../ui/kit/PillButton';

/** A bundle of /v1/device/<id>/firmware/ - with whether it can go on remotely. */
type FirmwareBundle = {
  id: string;
  release: string | null;
  firmware: string | null;
  created: string | null;
  latest_in: string[];
  remote: boolean;
  reason: string | null;
};

type UpdateState = {
  command_id: number;
  phase: 'reading_config' | 'upgrading';
  status: 'pending' | 'sent' | 'success' | 'failed' | 'timeout' | 'expired' | 'cancelled';
  /** Still running - no new update until it finished or stopped downloading. */
  running: boolean;
  from: string | null;
  to: string | null;
  target: string | null;
  error: string | null;
};

type FirmwareResponse = { current: string | null; bundles: FirmwareBundle[]; update: UpdateState | null };

const REFRESH_MS = 5000;
const MUTED = '#8B8383';

const sectionTitle: CSSProperties = {
  fontSize: 11,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: MUTED,
  fontWeight: 500,
  marginBottom: 8,
};

const inputStyle: CSSProperties = {
  height: 32,
  border: '1px solid var(--progeo-track)',
  borderRadius: 8,
  padding: '0 10px',
  fontSize: 13,
  fontFamily: 'inherit',
  background: 'var(--progeo-surface)',
  color: 'var(--progeo-blue)',
  minWidth: 0,
};

/**
 * Remote firmware update of one controller (staff, in the commands dialog):
 * the bundle it runs, the bundles it can be taken to over its command poll
 * (helper/firmware_update.py) and the step that runs. `onChanged` reloads
 * the command history, which lists every step.
 */
const DeviceFirmwareUpdate = ({
  deviceId,
  query,
  onChanged,
}: {
  deviceId: number;
  query: string;
  onChanged: () => void;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [data, setData] = useState<FirmwareResponse | null>(null);
  const [target, setTarget] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);
  const base = `/v1/device/${deviceId}/firmware/`;

  const load = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void axiosConfig.perform_get(
      auth,
      `${base}${query}`,
      (response) => {
        if (closedRef.current) {
          return;
        }
        const next = response?.data as FirmwareResponse;
        setData(next);
        setTarget((current) => {
          const remote = (next?.bundles ?? []).filter((bundle) => bundle.remote);
          return remote.some((bundle) => bundle.id === current) ? current : (remote[0]?.id ?? '');
        });
        if (next?.update?.running) {
          timerRef.current = setTimeout(load, REFRESH_MS);
        }
      },
      (error) => showRequestError(enqueueSnackbar, t('device_firmware_load_failed'), error),
    );
  };

  useEffect(() => {
    closedRef.current = false;
    load();
    return () => {
      closedRef.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, query]);

  const start = () => {
    setBusy(true);
    setConfirming(false);
    void axiosConfig.perform_post(
      auth,
      `${base}update/${query}`,
      { bundle: target },
      () => {
        setBusy(false);
        showSuccessBar(enqueueSnackbar, t('device_firmware_started', { bundle: target }));
        load();
        onChanged();
      },
      (error) => {
        setBusy(false);
        showRequestError(enqueueSnackbar, t('device_firmware_start_failed'), error);
      },
    );
  };

  if (!data) {
    return (
      <div>
        <div style={sectionTitle}>{t('device_firmware_title')}</div>
        <Spinner animation="border" size="sm" />
      </div>
    );
  }

  const update = data.update;
  const running = update?.running ?? false;
  const remote = data.bundles.filter((bundle) => bundle.remote);
  const others = data.bundles.filter((bundle) => !bundle.remote && bundle.id !== data.current);
  const bundleLabel = (bundle: FirmwareBundle) =>
    `${bundle.id}${bundle.latest_in.length ? ` (${bundle.latest_in.join(', ')})` : ''}`;

  return (
    <div>
      <div style={sectionTitle}>{t('device_firmware_title')}</div>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        {data.current ? t('device_firmware_current', { bundle: data.current }) : t('device_firmware_unknown')}
      </div>

      {update && (
        <div
          style={{
            fontSize: 12.5,
            marginBottom: 10,
            padding: '8px 12px',
            borderRadius: 10,
            background: update.status === 'failed' || update.status === 'timeout' ? '#FBE9E3' : '#E3ECF4',
            color: update.status === 'failed' || update.status === 'timeout' ? '#C44D26' : 'var(--progeo-blue)',
          }}
        >
          <strong>{t(`device_firmware_phase_${update.phase}`)}</strong>
          {' · '}
          {t('device_firmware_step', { from: update.from ?? '?', to: update.to ?? '?' })}
          {update.target && update.target !== update.to
            ? ` · ${t('device_firmware_target_note', { target: update.target })}`
            : ''}
          {' · '}
          {t(`device_commands_status_${update.status}`)}
          {update.error ? ` - ${update.error}` : ''}
        </div>
      )}

      {data.current && !running && (
        remote.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <select
              aria-label={t('device_firmware_target')}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setConfirming(false);
              }}
              style={inputStyle}
            >
              {remote.map((bundle) => (
                <option key={bundle.id} value={bundle.id}>
                  {bundleLabel(bundle)}
                </option>
              ))}
            </select>
            <PillButton
              variant={confirming ? 'solid' : 'accent'}
              icon={busy ? <Spinner animation="border" size="sm" /> : undefined}
              label={confirming ? t('device_firmware_confirm', { bundle: target }) : t('device_firmware_start')}
              disabled={busy || !target}
              onClick={() => (confirming ? start() : setConfirming(true))}
            />
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: MUTED }}>{t('device_firmware_none')}</div>
        )
      )}

      {data.current && others.length > 0 && (
        <ul style={{ fontSize: 12, color: MUTED, margin: '8px 0 0', paddingLeft: 18 }}>
          {others.map((bundle) => (
            <li key={bundle.id}>
              {bundleLabel(bundle)} - {t('device_firmware_not_remote', { reason: bundle.reason ?? '' })}
            </li>
          ))}
        </ul>
      )}
      <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>{t('device_firmware_hint')}</div>
    </div>
  );
};

export default DeviceFirmwareUpdate;
