import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { Spinner } from 'react-bootstrap';
import { Plus, X } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { formatDate } from '../../main/dateFormat';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PillButton from '../ui/kit/PillButton';
import { type ParamOption, SET_PARAMS } from './deviceParams';

/** A row of /v1/device/<id>/commands/ - payload and result are never listed. */
type DeviceCommand = {
  id: number;
  command: string;
  status: 'pending' | 'sent' | 'success' | 'failed' | 'timeout' | 'expired' | 'cancelled';
  created: string | null;
  sent_at: string | null;
  finished_at: string | null;
  created_by: string | null;
  summary: { params?: Record<string, unknown>; path?: string; bytes?: number; sha256?: string; hour?: number };
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

const MUTED = '#8B8383';

const STATUS_COLORS: Record<DeviceCommand['status'], [string, string]> = {
  pending: ['#8A6D1F', '#FBF3DC'],
  sent: ['var(--progeo-blue)', '#E3ECF4'],
  success: ['#3F7A1C', '#EBF4E3'],
  failed: ['#C44D26', '#FBE9E3'],
  timeout: ['#C44D26', '#FBE9E3'],
  expired: ['#6E6868', 'var(--progeo-track-soft)'],
  cancelled: ['#6E6868', 'var(--progeo-track-soft)'],
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

const thStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: MUTED,
  fontWeight: 500,
  padding: '0 8px 8px',
  textAlign: 'left',
  whiteSpace: 'nowrap',
};

const tdStyle: CSSProperties = {
  padding: '8px',
  borderTop: '1px solid var(--progeo-track)',
  fontSize: 12.5,
  verticalAlign: 'top',
};

const sectionTitle: CSSProperties = {
  fontSize: 11,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: MUTED,
  fontWeight: 500,
  marginBottom: 8,
};

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
}: {
  device: CommandDevice;
  isSuperuser: boolean;
  canEdit: boolean;
  onClose: () => void;
}) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
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
    const [color, background] = STATUS_COLORS[command.status] ?? STATUS_COLORS.expired;
    return (
      <span
        title={command.error ?? undefined}
        style={{
          display: 'inline-block',
          fontSize: 11.5,
          fontWeight: 600,
          color,
          background,
          borderRadius: 'var(--progeo-radius-pill)',
          padding: '2px 9px',
          whiteSpace: 'nowrap',
        }}
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
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(7, 34, 58, .38)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-label={t('device_commands_title')}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 860,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--progeo-panel-bg)',
          borderRadius: 18,
          boxShadow: '0 20px 60px rgba(11, 54, 89, .3)',
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          color: 'var(--progeo-blue)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {t('device_commands_title')} · {device.display_name || device.raw_hash}
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
              {data?.last_command_poll
                ? t('device_commands_last_poll', { time: time(data.last_command_poll) })
                : t('device_commands_never_polled')}
              {data ? ` · ${t('device_commands_ttl', { hours: data.pending_ttl_hours })}` : ''}
            </div>
          </div>
          <button
            type="button"
            title={t('devices_cancel')}
            onClick={onClose}
            style={{ border: 'none', background: 'transparent', color: MUTED, cursor: 'pointer', padding: 4 }}
          >
            <X size={20} />
          </button>
        </div>

        {!data ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
            <Spinner animation="border" />
          </div>
        ) : (
          <>
            {canEdit && (
              <div>
                <div style={sectionTitle}>{t('device_commands_send')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
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
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {allowed('logs') && (
              <div>
                <div style={sectionTitle}>{t('device_command_logs')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <select
                    aria-label={t('device_commands_logs_hour_label')}
                    value={logHour}
                    onChange={(event) => setLogHour(Number(event.target.value))}
                    style={inputStyle}
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
                  />
                  <PillButton
                    variant="accent"
                    label={t('device_commands_logs_day')}
                    disabled={busy !== null}
                    onClick={() => queue('logs', undefined, undefined, HOURS.map((hour) => ({ hour })))}
                  />
                  <span style={{ fontSize: 11.5, color: MUTED }}>{t('device_commands_logs_hint')}</span>
                </div>
              </div>
            )}

            {allowed('set_params') && (
              <div>
                <div style={sectionTitle}>{t('device_command_set_params')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {params.map((row, index) => (
                    <div key={row.key} style={{ display: 'flex', gap: 6 }}>
                      <select
                        aria-label={t('device_commands_param_key')}
                        value={row.key}
                        onChange={(event) =>
                          // Another parameter - its own first valid value.
                          setParams(params.map((p, i) => (i === index ? paramRow(event.target.value) : p)))
                        }
                        style={{ ...inputStyle, flex: 1 }}
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
                        style={{ ...inputStyle, flex: 1 }}
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
                        disabled={params.length === 1}
                        onClick={() => setParams(params.filter((_, i) => i !== index))}
                        style={{ border: 'none', background: 'transparent', color: MUTED, cursor: 'pointer' }}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <PillButton
                      variant="ghost"
                      icon={<Plus size={14} />}
                      label={t('device_commands_param_add')}
                      disabled={unusedKeys().length === 0}
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
                    />
                    <span style={{ fontSize: 11.5, color: MUTED }}>{t('device_commands_params_hint')}</span>
                  </div>
                </div>
              </div>
            )}

            {isSuperuser && allowed('update') && (
              <div>
                <div style={sectionTitle}>{t('device_command_update')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    aria-label={t('device_commands_update_path')}
                    value={updatePath}
                    onChange={(event) => setUpdatePath(event.target.value)}
                    style={inputStyle}
                    className="font-monospace"
                  />
                  <textarea
                    aria-label={t('device_commands_update_content')}
                    placeholder={t('device_commands_update_content')}
                    value={updateContent}
                    onChange={(event) => setUpdateContent(event.target.value)}
                    rows={8}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-monospace"
                    style={{ ...inputStyle, height: 'auto', padding: 10, fontSize: 12, resize: 'vertical' }}
                  />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <PillButton
                      variant="accent"
                      label={t('device_commands_send_update')}
                      icon={busy === 'update' ? <Spinner animation="border" size="sm" /> : undefined}
                      disabled={busy !== null || !updateContent.trim()}
                      onClick={sendUpdate}
                    />
                    <span style={{ fontSize: 11.5, color: MUTED }}>{t('device_commands_update_hint')}</span>
                  </div>
                </div>
              </div>
            )}

            {result && (
              <div>
                <div style={{ ...sectionTitle, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{t('device_commands_result_title', { command: commandLabel(result.command), id: result.id })}</span>
                  <span style={{ display: 'inline-flex', gap: 8 }}>
                    {resultConfig && allowed('update') && (
                      <PillButton
                        variant="ghost"
                        label={t('device_commands_result_edit')}
                        onClick={() => {
                          setUpdatePath(resultConfig.path || DEFAULT_CONFIG_PATH);
                          setUpdateContent(resultConfig.content);
                          setResult(null);
                        }}
                      />
                    )}
                    <PillButton variant="ghost" label={t('device_commands_result_hide')} onClick={() => setResult(null)} />
                  </span>
                </div>
                {resultEntries ? (
                  // identify: chip id, IP, MAC, ... as a small table.
                  <table
                    style={{ borderCollapse: 'collapse', background: 'var(--progeo-surface)', borderRadius: 10 }}
                  >
                    <tbody>
                      {resultEntries.map(([key, value]) => (
                        <tr key={key}>
                          <td style={{ ...tdStyle, color: MUTED, borderTop: 'none', paddingRight: 24 }}>
                            {t(`device_commands_identity_${key}`, { defaultValue: key })}
                          </td>
                          <td style={{ ...tdStyle, borderTop: 'none' }} className="font-monospace">
                            {value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      borderRadius: 10,
                      background: 'var(--progeo-surface)',
                      fontSize: 12,
                      maxHeight: 280,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {resultText ? resultText.content : JSON.stringify(result.value, null, 2)}
                  </pre>
                )}
              </div>
            )}

            <div>
              <div style={sectionTitle}>{t('device_commands_history')}</div>
              {commands.length === 0 ? (
                <div style={{ fontSize: 13, color: MUTED }}>{t('device_commands_none')}</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>{t('device_commands_col_command')}</th>
                        <th style={thStyle}>{t('device_commands_col_status')}</th>
                        <th style={thStyle}>{t('device_commands_col_created')}</th>
                        <th style={thStyle}>{t('device_commands_col_finished')}</th>
                        <th style={thStyle} />
                      </tr>
                    </thead>
                    <tbody>
                      {commands.map((command) => (
                        <tr key={command.id}>
                          <td style={tdStyle}>
                            <div style={{ fontWeight: 500 }}>
                              {commandLabel(command.command)}{' '}
                              <span style={{ color: MUTED, fontWeight: 400 }}>#{command.id}</span>
                            </div>
                            {summaryText(command) && (
                              <div className="font-monospace" style={{ fontSize: 11.5, color: MUTED }}>
                                {summaryText(command)}
                              </div>
                            )}
                            {command.error && (
                              <div style={{ fontSize: 11.5, color: '#C44D26' }}>{command.error}</div>
                            )}
                          </td>
                          <td style={tdStyle}>{statusChip(command)}</td>
                          <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                            {time(command.created)}
                            {command.created_by && (
                              <div style={{ fontSize: 11.5, color: MUTED }}>{command.created_by}</div>
                            )}
                          </td>
                          <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                            {command.finished_at
                              ? time(command.finished_at)
                              : command.sent_at
                                ? t('device_commands_sent_at', { time: time(command.sent_at) })
                                : '–'}
                          </td>
                          <td style={{ ...tdStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
                            {command.status === 'pending' && canEdit && (
                              <PillButton variant="ghost" label={t('device_commands_cancel')} onClick={() => cancel(command)} />
                            )}
                            {command.has_result && isSuperuser && (
                              <PillButton
                                variant="ghost"
                                label={t('device_commands_show_result')}
                                onClick={() => showResult(command)}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ fontSize: 11.5, color: MUTED, marginTop: 8 }}>
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
