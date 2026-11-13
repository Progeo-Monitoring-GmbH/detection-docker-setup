import { useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PillButton from '../ui/kit/PillButton';
// Section title, select and row are shared with the dialog it sits in.
import './DeviceCommandsDialog.css';
import { childTestId, repeatedTestId } from '../../testIds';

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
  testId = 'device-firmware',
}: {
  deviceId: number;
  query: string;
  onChanged: () => void;
  /** data-testid of the section; its parts are "<testId>-current", "-target", "-start", ... */
  testId?: string;
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
      <div data-testid={testId}>
        <div className="device-commands-section-title">{t('device_firmware_title')}</div>
        <Spinner animation="border" size="sm" data-testid={childTestId(testId, 'loading')} />
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
    <div data-testid={testId}>
      <div className="device-commands-section-title">{t('device_firmware_title')}</div>
      <div className="device-firmware-current" data-testid={childTestId(testId, 'current')}>
        {data.current ? t('device_firmware_current', { bundle: data.current }) : t('device_firmware_unknown')}
      </div>

      {update && (
        <div
          className={
            update.status === 'failed' || update.status === 'timeout'
              ? 'device-firmware-state device-firmware-state--failed'
              : 'device-firmware-state'
          }
          data-testid={childTestId(testId, 'state')}
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
          <div className="device-commands-row">
            <select
              aria-label={t('device_firmware_target')}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setConfirming(false);
              }}
              className="device-commands-input"
              data-testid={childTestId(testId, 'target')}
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
              testId={childTestId(testId, 'start')}
            />
          </div>
        ) : (
          <div className="device-firmware-none" data-testid={childTestId(testId, 'none')}>{t('device_firmware_none')}</div>
        )
      )}

      {data.current && others.length > 0 && (
        <ul className="device-firmware-others" data-testid={childTestId(testId, 'others')}>
          {others.map((bundle) => (
            <li key={bundle.id} {...repeatedTestId(`${testId}-other`, bundle.id)}>
              {bundleLabel(bundle)} - {t('device_firmware_not_remote', { reason: bundle.reason ?? '' })}
            </li>
          ))}
        </ul>
      )}
      <div className="device-firmware-hint">{t('device_firmware_hint')}</div>
    </div>
  );
};

export default DeviceFirmwareUpdate;
