import { useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { Spinner } from 'react-bootstrap';
import { Plus, X } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { staffFlags } from '../../main/access';
import { formatDate } from '../../main/dateFormat';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PillButton from '../ui/kit/PillButton';
import DeviceFirmwareUpdate from './DeviceFirmwareUpdate';
import { type ParamOption, SET_PARAMS } from './deviceParams';
import { childTestId, repeatedTestId } from '../../testIds';
import './DeviceCommandsDialog.css';

/** A row of /v1/device/<id>/commands/ - payload and result are never listed. */
type DeviceCommand = {
  id: number;
  command: string;
  status: 'pending' | 'sent' | 'success' | 'failed' | 'timeout' | 'expired' | 'cancelled';
  created: string | null;
  sent_at: string | null;
  finished_at: string | null;
  created_by: string | null;
  summary: {
    params?: Record<string, unknown>;
    path?: string;
    bytes?: number;
    sha256?: string;
    hour?: number;
    /** A step of a firmware update ("upgrade", or the "get_config" before it). */
    upgrade?: { from: string; to: string; target: string };
  };
  error: string | null;
  has_result: boolean;
};

type CommandChoice = { command: string; superuser_only: boolean; allowed: boolean };

type CommandsResponse = {
  commands: DeviceCommand[];
  available: CommandChoice[];
  pending_ttl_hours: number;
  result_ttl_days: number;
  last_command_poll: string | null;
};

type CommandDevice = { id: number; location: number | null; raw_hash: string; display_name?: string };

/** A set_params row: one of SET_PARAMS and one of its option values. */
type ParamRow = { key: string; value: number };

const paramSpec = (key: string) => SET_PARAMS.find((spec) => spec.key === key) ?? SET_PARAMS[0];
const paramRow = (key: string): ParamRow => ({ key, value: paramSpec(key).options[0].value });

// One click queues these; set_params and update have their own forms.
const SIMPLE_COMMANDS = ['identify', 'measure', 'get_config', 'maintenance', 'normal', 'restart'];
// logs: one command per hour of the day (the controller sends that hour's log).
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
// Asked again before queueing.
const CONFIRM_COMMANDS = new Set(['restart']);
const OPEN_STATUSES = new Set(['pending', 'sent']);
const REFRESH_MS = 5000;
const DEFAULT_CONFIG_PATH = 'config/device_config.lua';

/** A result that is a flat object of plain values (identify: chip id, IP, ...). */
const flatEntries = (value: unknown): [string, string][] | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.some(([, item]) => item !== null && typeof item === 'object')) {
    return null;
  }
  return entries.map(([key, item]) => [key, item === null ? '–' : String(item)]);
};

const time = (value: string | null) => (value ? formatDate(value, 'dateTimeSeconds') : '–');

/**
 * Commands of one controller (device overview, staff): queue them for its
 * next poll of sample/cc and follow whether they ran. The backend keeps
 * payloads encrypted until the controller took them and lists only a
 * redacted summary; results (get_config: the whole config) are shown to
 * superusers on request.
 */
const DeviceCommandsDialog = ({
  device,
  isSuperuser,
  canEdit,
  onClose,
  testId = 'device-commands',
}: {
  device: CommandDevice;
  isSuperuser: boolean;
  canEdit: boolean;
  onClose: () => void;
  /** data-testid of the dialog; its parts are "<testId>-close", "-command", "-history-row", ... */
  testId?: string;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  // Firmware updates: staff only (the backend's is_staff_admin).
  const { isStaffOrSuperuser: isStaff } = staffFlags(auth?.user);
  const [data, setData] = useState<CommandsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [params, setParams] = useState<ParamRow[]>([paramRow(SET_PARAMS[0].key)]);
  const [updatePath, setUpdatePath] = useState(DEFAULT_CONFIG_PATH);
  const [updateContent, setUpdateContent] = useState('');
  const [logHour, setLogHour] = useState(() => new Date().getHours());
  const [result, setResult] = useState<{ id: number; command: string; value: unknown } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);

  const query = device.location ? `?location=${device.location}` : '';
  const base = `/v1/device/${device.id}/commands/`;

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
        const next = response?.data as CommandsResponse;
        setData(next);
        // Follow open commands until the controller answered.
        if (next?.commands?.some((command) => OPEN_STATUSES.has(command.status))) {
          timerRef.current = setTimeout(load, REFRESH_MS);
        }
      },
      (error) => showRequestError(enqueueSnackbar, t('device_commands_load_failed'), error),
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
  }, [device.id, device.location]);

  const commandLabel = (command: string) => t(`device_command_${command}`);

  /** `payload`, or `payloads` to queue the command once per entry (logs of a whole day). */
  const queue = (command: string, payload?: unknown, onQueued?: () => void, payloads?: unknown[]) => {
    setBusy(command);
    setConfirming(null);
    void axiosConfig.perform_post(
      auth,
      `${base}queue/${query}`,
      payloads ? { command, payloads } : payload === undefined ? { command } : { command, payload },
      () => {
        setBusy(null);
        showSuccessBar(enqueueSnackbar, t('device_commands_queued', { command: commandLabel(command) }));
        onQueued?.();
        load();
      },
      (error) => {
        setBusy(null);
        showRequestError(enqueueSnackbar, t('device_commands_queue_failed', { command: commandLabel(command) }), error);
      },
    );
  };

  const cancel = (command: DeviceCommand) => {
    void axiosConfig.perform_post(
      auth,
      `${base}${command.id}/cancel/${query}`,
      {},
      () => load(),
      (error) => showRequestError(enqueueSnackbar, t('device_commands_cancel_failed'), error),
    );
  };

  const showResult = (command: DeviceCommand) => {
    void axiosConfig.perform_get(
      auth,
      `${base}${command.id}/result/${query}`,
      (response) => setResult({ id: command.id, command: command.command, value: response?.data?.result }),
      (error) => showRequestError(enqueueSnackbar, t('device_commands_result_failed'), error),
    );
  };

  const sendParams = () => {
    const payload: Record<string, number> = {};
    params.forEach(({ key, value }) => {
      payload[key] = value;
    });
    queue('set_params', payload);
  };

  const optionLabel = (option: ParamOption) =>
    option.labelKey ? t(option.labelKey) : `${option.label} (${option.value})`;
  // Each parameter once: a row offers its own key and the unused ones.
  const unusedKeys = (except?: string) =>
    SET_PARAMS.filter((spec) => spec.key === except || !params.some((row) => row.key === spec.key));

  const sendUpdate = () =>
    queue('update', { path: updatePath.trim() || DEFAULT_CONFIG_PATH, content: updateContent }, () => {
      // Not kept in the page longer than needed (it holds credentials).
      setUpdateContent('');
    });

  const allowed = (command: string) =>
    canEdit && (data?.available ?? []).some((choice) => choice.command === command && choice.allowed);

  const configContent = (value: unknown) =>
    value && typeof value === 'object' && typeof (value as { content?: unknown }).content === 'string'
      ? (value as { content: string; path?: string })
      : null;

  const summaryText = (command: DeviceCommand) => {
    const { summary } = command;
    if (summary.upgrade) {
      return t('device_firmware_step', { from: summary.upgrade.from, to: summary.upgrade.to });
    }
    if (summary.params) {
      return Object.entries(summary.params)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(', ');
    }
    if (typeof summary.hour === 'number') {
      return t('device_commands_logs_hour', { hour: String(summary.hour).padStart(2, '0') });
    }
    if (summary.path) {
      return `${summary.path} · ${summary.bytes ?? 0} B`;
    }
    return '';
  };

  const statusChip = (command: DeviceCommand) => {
    return (
      <span
        title={command.error ?? undefined}
        data-testid={childTestId(testId, 'status')}
        data-test-key={command.id}
        className={`device-commands-status device-commands-status--${command.status}`}
      >
        {t(`device_commands_status_${command.status}`)}
      </span>
    );
  };

  const commands = data?.commands ?? [];
  // Text results (config, logs) are shown as text; only a config can be sent back as update.
  const resultText = result ? configContent(result.value) : null;
  const resultConfig = result?.command === 'get_config' ? resultText : null;
  const resultEntries = result && !resultText ? flatEntries(result.value) : null;

  return (
    <div onClick={onClose} className="progeo-dialog-backdrop" data-testid={childTestId(testId, 'backdrop')}>
      <div
        role="dialog"
        aria-label={t('device_commands_title')}
        onClick={(event) => event.stopPropagation()}
        className="device-commands-dialog"
        data-testid={testId}
      >
        <div className="device-commands-header">
          <div>
            <div className="device-commands-title">
              {t('device_commands_title')} · {device.display_name || device.raw_hash}
            </div>
            <div className="device-commands-subtitle" data-testid={childTestId(testId, 'last-poll')}>
              {data?.last_command_poll
                ? t('device_commands_last_poll', { time: time(data.last_command_poll) })
                : t('device_commands_never_polled')}
              {data ? ` · ${t('device_commands_ttl', { hours: data.pending_ttl_hours })}` : ''}
            </div>
          </div>
          <button
            type="button"
            title={t('devices_cancel')}
            aria-label={t('devices_cancel')}
            onClick={onClose}
            className="device-commands-close"
            data-testid={childTestId(testId, 'close')}
          >
            <X size={20} />
          </button>
        </div>

        {!data ? (
          <div className="device-commands-loading" data-testid={childTestId(testId, 'loading')}>
            <Spinner animation="border" />
          </div>
        ) : (
          <>
            {canEdit && (
              <div>
                <div className="device-commands-section-title">{t('device_commands_send')}</div>
                <div className="device-commands-actions" data-testid={childTestId(testId, 'actions')}>
                  {SIMPLE_COMMANDS.filter(allowed).map((command) => {
                    const asking = confirming === command;
                    return (
                      <PillButton
                        key={command}
                        // Asking to confirm: no longer orange, the label asks.
                        variant={asking ? 'solid' : 'accent'}
                        icon={busy === command ? <Spinner animation="border" size="sm" /> : undefined}
                        label={asking ? t('device_commands_confirm', { command: commandLabel(command) }) : commandLabel(command)}
                        title={t(`device_command_${command}_hint`)}
                        disabled={busy !== null}
                        onClick={() =>
                          CONFIRM_COMMANDS.has(command) && !asking ? setConfirming(command) : queue(command)
                        }
                        testId={childTestId(testId, 'command')}
                        testKey={command}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {canEdit && isStaff && (
              <DeviceFirmwareUpdate
                deviceId={device.id}
                query={query}
                onChanged={load}
                testId={childTestId(testId, 'firmware')}
              />
            )}

            {allowed('logs') && (
              <div>
                <div className="device-commands-section-title">{t('device_command_logs')}</div>
                <div className="device-commands-row">
                  <select
                    aria-label={t('device_commands_logs_hour_label')}
                    value={logHour}
                    onChange={(event) => setLogHour(Number(event.target.value))}
                    className="device-commands-input"
                    data-testid={childTestId(testId, 'logs-hour')}
                  >
                    {HOURS.map((hour) => (
                      <option key={hour} value={hour}>
                        {t('device_commands_logs_hour', { hour: String(hour).padStart(2, '0') })}
                      </option>
                    ))}
                  </select>
                  <PillButton
                    variant="accent"
                    label={t('device_commands_logs_get')}
                    icon={busy === 'logs' ? <Spinner animation="border" size="sm" /> : undefined}
                    disabled={busy !== null}
                    onClick={() => queue('logs', { hour: logHour })}
                    testId={childTestId(testId, 'logs-get')}
                  />
                  <PillButton
                    variant="accent"
                    label={t('device_commands_logs_day')}
                    disabled={busy !== null}
                    onClick={() => queue('logs', undefined, undefined, HOURS.map((hour) => ({ hour })))}
                    testId={childTestId(testId, 'logs-day')}
                  />
                  <span className="device-commands-hint">{t('device_commands_logs_hint')}</span>
                </div>
              </div>
            )}

            {allowed('set_params') && (
              <div>
                <div className="device-commands-section-title">{t('device_command_set_params')}</div>
                <div className="device-commands-stack">
                  {params.map((row, index) => (
                    <div key={row.key} className="device-commands-param" {...repeatedTestId(`${testId}-param`, row.key)}>
                      <select
                        aria-label={t('device_commands_param_key')}
                        value={row.key}
                        onChange={(event) =>
                          // Another parameter - its own first valid value.
                          setParams(params.map((p, i) => (i === index ? paramRow(event.target.value) : p)))
                        }
                        className="device-commands-input device-commands-input--grow"
                        data-testid={childTestId(testId, 'param-key')}
                        data-test-key={row.key}
                      >
                        {unusedKeys(row.key).map((spec) => (
                          <option key={spec.key} value={spec.key}>
                            {t(spec.labelKey)} ({spec.key})
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={t('device_commands_param_value')}
                        value={row.value}
                        onChange={(event) =>
                          setParams(params.map((p, i) => (i === index ? { ...p, value: Number(event.target.value) } : p)))
                        }
                        className="device-commands-input device-commands-input--grow"
                        data-testid={childTestId(testId, 'param-value')}
                        data-test-key={row.key}
                      >
                        {paramSpec(row.key).options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {optionLabel(option)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        title={t('device_commands_param_remove')}
                        aria-label={t('device_commands_param_remove')}
                        disabled={params.length === 1}
                        onClick={() => setParams(params.filter((_, i) => i !== index))}
                        className="device-commands-param-remove"
                        data-testid={childTestId(testId, 'param-remove')}
                        data-test-key={row.key}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <div className="device-commands-inline">
                    <PillButton
                      variant="ghost"
                      icon={<Plus size={14} />}
                      label={t('device_commands_param_add')}
                      disabled={unusedKeys().length === 0}
                      testId={childTestId(testId, 'param-add')}
                      onClick={() => {
                        const [next] = unusedKeys();
                        if (next) {
                          setParams([...params, paramRow(next.key)]);
                        }
                      }}
                    />
                    <PillButton
                      variant="accent"
                      label={t('device_commands_send_params')}
                      icon={busy === 'set_params' ? <Spinner animation="border" size="sm" /> : undefined}
                      disabled={busy !== null || params.length === 0}
                      onClick={sendParams}
                      testId={childTestId(testId, 'send-params')}
                    />
                    <span className="device-commands-hint">{t('device_commands_params_hint')}</span>
                  </div>
                </div>
              </div>
            )}

            {isSuperuser && allowed('update') && (
              <div>
                <div className="device-commands-section-title">{t('device_command_update')}</div>
                <div className="device-commands-stack">
                  <input
                    aria-label={t('device_commands_update_path')}
                    value={updatePath}
                    onChange={(event) => setUpdatePath(event.target.value)}
                    className="device-commands-input font-monospace"
                    data-testid={childTestId(testId, 'update-path')}
                  />
                  <textarea
                    aria-label={t('device_commands_update_content')}
                    placeholder={t('device_commands_update_content')}
                    value={updateContent}
                    onChange={(event) => setUpdateContent(event.target.value)}
                    rows={8}
                    spellCheck={false}
                    autoComplete="off"
                    className="device-commands-input device-commands-input--text font-monospace"
                    data-testid={childTestId(testId, 'update-content')}
                  />
                  <div className="device-commands-inline">
                    <PillButton
                      variant="accent"
                      label={t('device_commands_send_update')}
                      icon={busy === 'update' ? <Spinner animation="border" size="sm" /> : undefined}
                      disabled={busy !== null || !updateContent.trim()}
                      onClick={sendUpdate}
                      testId={childTestId(testId, 'send-update')}
                    />
                    <span className="device-commands-hint">{t('device_commands_update_hint')}</span>
                  </div>
                </div>
              </div>
            )}

            {result && (
              <div data-testid={childTestId(testId, 'result')}>
                <div className="device-commands-section-title device-commands-section-title--split">
                  <span>{t('device_commands_result_title', { command: commandLabel(result.command), id: result.id })}</span>
                  <span className="device-commands-result-actions">
                    {resultConfig && allowed('update') && (
                      <PillButton
                        variant="ghost"
                        label={t('device_commands_result_edit')}
                        testId={childTestId(testId, 'result-edit')}
                        onClick={() => {
                          setUpdatePath(resultConfig.path || DEFAULT_CONFIG_PATH);
                          setUpdateContent(resultConfig.content);
                          setResult(null);
                        }}
                      />
                    )}
                    <PillButton
                      variant="ghost"
                      label={t('device_commands_result_hide')}
                      onClick={() => setResult(null)}
                      testId={childTestId(testId, 'result-hide')}
                    />
                  </span>
                </div>
                {resultEntries ? (
                  // identify: chip id, IP, MAC, ... as a small table.
                  <table className="device-commands-identity" data-testid={childTestId(testId, 'identity')}>
                    <tbody>
                      {resultEntries.map(([key, value]) => (
                        <tr key={key} {...repeatedTestId(`${testId}-identity-row`, key)}>
                          <td className="device-commands-cell device-commands-cell--key">
                            {t(`device_commands_identity_${key}`, { defaultValue: key })}
                          </td>
                          <td className="device-commands-cell device-commands-cell--value font-monospace">
                            {value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <pre className="device-commands-result">
                    {resultText ? resultText.content : JSON.stringify(result.value, null, 2)}
                  </pre>
                )}
              </div>
            )}

            <div>
              <div className="device-commands-section-title">{t('device_commands_history')}</div>
              {commands.length === 0 ? (
                <div className="device-commands-empty" data-testid={childTestId(testId, 'empty')}>{t('device_commands_none')}</div>
              ) : (
                <div className="device-commands-scroll">
                  <table className="device-commands-table" data-testid={childTestId(testId, 'history')}>
                    <thead>
                      <tr>
                        <th className="device-commands-th">{t('device_commands_col_command')}</th>
                        <th className="device-commands-th">{t('device_commands_col_status')}</th>
                        <th className="device-commands-th">{t('device_commands_col_created')}</th>
                        <th className="device-commands-th">{t('device_commands_col_finished')}</th>
                        <th className="device-commands-th" />
                      </tr>
                    </thead>
                    <tbody>
                      {commands.map((command) => (
                        <tr key={command.id} {...repeatedTestId(`${testId}-history-row`, command.id)}>
                          <td className="device-commands-cell">
                            <div className="device-commands-name">
                              {commandLabel(command.command)}{' '}
                              <span className="device-commands-id">#{command.id}</span>
                            </div>
                            {summaryText(command) && (
                              <div className="device-commands-hint font-monospace">
                                {summaryText(command)}
                              </div>
                            )}
                            {command.error && (
                              <div className="device-commands-error" data-testid={childTestId(testId, 'error')} data-test-key={command.id}>{command.error}</div>
                            )}
                          </td>
                          <td className="device-commands-cell">{statusChip(command)}</td>
                          <td className="device-commands-cell device-commands-cell--nowrap">
                            {time(command.created)}
                            {command.created_by && (
                              <div className="device-commands-hint">{command.created_by}</div>
                            )}
                          </td>
                          <td className="device-commands-cell device-commands-cell--nowrap">
                            {command.finished_at
                              ? time(command.finished_at)
                              : command.sent_at
                                ? t('device_commands_sent_at', { time: time(command.sent_at) })
                                : '–'}
                          </td>
                          <td className="device-commands-cell device-commands-cell--nowrap device-commands-cell--end">
                            {command.status === 'pending' && canEdit && (
                              <PillButton
                                variant="ghost"
                                label={t('device_commands_cancel')}
                                onClick={() => cancel(command)}
                                testId={childTestId(testId, 'cancel')}
                                testKey={String(command.id)}
                              />
                            )}
                            {command.has_result && isSuperuser && (
                              <PillButton
                                variant="ghost"
                                label={t('device_commands_show_result')}
                                onClick={() => showResult(command)}
                                testId={childTestId(testId, 'show-result')}
                                testKey={String(command.id)}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="device-commands-hint device-commands-privacy">
                {t('device_commands_privacy', { days: data.result_ttl_days })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DeviceCommandsDialog;
