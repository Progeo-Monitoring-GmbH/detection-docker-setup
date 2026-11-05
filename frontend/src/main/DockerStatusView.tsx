import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Spinner } from 'react-bootstrap';
import { ArrowClockwise, BootstrapReboot, Clipboard, FileText, PauseFill, PlayFill } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { errorReason, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import DeleteIconButton from '../components/ui/kit/DeleteIconButton';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SearchableDataTable, { type SearchableColumn } from '../components/ui/kit/SearchableDataTable';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { formatRelativeTime } from './dateFormat';

/** A row of GET /api/docker/status/. */
export type DockerContainer = {
  id: string;
  name: string;
  /** running, exited, paused, restarting, created, dead ... */
  status: string;
  image?: string | null;
  started_at?: string | null;
  /** healthy / unhealthy / starting; null without a healthcheck. */
  health?: string | null;
};

type Action = 'start' | 'stop' | 'restart' | 'remove';

const API = '/api/docker/';
/** The list refreshes itself this often (containers change on their own). */
const REFRESH_MS = 15_000;
const LOG_TAILS = [200, 1000, 5000];

const MUTED = '#8B8383';
const STATUS_COLORS: Record<string, { color: string; background: string }> = {
  running: { color: '#3F7A1C', background: '#EBF4E3' },
  exited: { color: '#C44D26', background: '#FBE9E3' },
  dead: { color: '#C44D26', background: '#FBE9E3' },
  paused: { color: '#9A6700', background: '#FFF4D6' },
  restarting: { color: '#9A6700', background: '#FFF4D6' },
};
const HEALTH_COLORS: Record<string, string> = { healthy: '#3F7A1C', unhealthy: '#C44D26', starting: '#9A6700' };

const Chip = ({ label, color, background }: { label: string; color: string; background: string }) => (
  <span
    style={{
      fontSize: 11.5,
      fontWeight: 600,
      color,
      background,
      borderRadius: 'var(--progeo-radius-pill)',
      padding: '3px 10px',
      whiteSpace: 'nowrap',
    }}
  >
    {label}
  </span>
);

const iconButtonStyle = (disabled: boolean) => ({
  width: 30,
  height: 30,
  border: 'none',
  borderRadius: 9,
  background: 'var(--progeo-surface)',
  boxShadow: '0 2px 8px rgba(11, 54, 89, .12)',
  color: 'var(--progeo-blue)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.4 : 1,
  padding: 0,
});

const isRunning = (container: DockerContainer) => container.status === 'running';

/**
 * Developer -> Docker: the host's containers (GET /api/docker/status/,
 * refreshed every REFRESH_MS and after each action) with start / stop,
 * restart, remove (stopped containers only) and their logs (the last lines,
 * with timestamps). Restart and remove ask first. Staff only - the backend
 * also requires module_docker_enabled.
 */
const DockerStatusView = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const authRef = useRef(auth);
  authRef.current = auth;

  const [containers, setContainers] = useState<DockerContainer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Container id -> its running action (its buttons are disabled meanwhile).
  const [busy, setBusy] = useState<Record<string, Action>>({});
  const [confirm, setConfirm] = useState<{ container: DockerContainer; action: 'restart' | 'remove' } | null>(null);
  const [logs, setLogs] = useState<{ container: DockerContainer; text: string | null; tail: number } | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(() => {
    setRefreshing(true);
    void axiosConfig.perform_get(
      authRef.current,
      `${API}status/`,
      (response) => {
        setContainers(Array.isArray(response?.data?.container) ? response.data.container : []);
        setLoadError(null);
        setRefreshing(false);
      },
      (error) => {
        setLoadError(errorReason(error) || 'Unknown error');
        setRefreshing(false);
      },
    );
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const run = (container: DockerContainer, action: Action) => {
    setBusy((current) => ({ ...current, [container.id]: action }));
    const done = () =>
      setBusy((current) => {
        const { [container.id]: _done, ...rest } = current;
        return rest;
      });
    void axiosConfig.perform_post(
      authRef.current,
      `${API}${action}/`,
      { container_id: container.id },
      () => {
        showSuccessBar(enqueueSnackbar, t(`docker_${action}_done`, { name: container.name }));
        done();
        load();
      },
      (error) => {
        showRequestError(enqueueSnackbar, t(`docker_${action}_failed`, { name: container.name }), error);
        done();
        load();
      },
    );
  };

  const loadLogs = (container: DockerContainer, tail: number) => {
    setLogs({ container, text: null, tail });
    void axiosConfig.perform_post(
      authRef.current,
      `${API}logs/`,
      { container_id: container.id, tail },
      (response) => {
        setLogs((current) =>
          current && current.container.id === container.id && current.tail === tail
            ? { ...current, text: String(response?.data?.logs ?? '') }
            : current,
        );
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('docker_logs_failed', { name: container.name }), error);
        setLogs(null);
      },
    );
  };

  // The newest lines are at the end - start there.
  useEffect(() => {
    if (logs?.text != null && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs?.text]);

  const copyLogs = () => {
    if (logs?.text == null) {
      return;
    }
    navigator.clipboard
      .writeText(logs.text)
      .then(() => showSuccessBar(enqueueSnackbar, t('docker_logs_copied')))
      .catch((error) => showRequestError(enqueueSnackbar, t('docker_logs_copy_failed'), error));
  };

  const columns = useMemo<SearchableColumn<DockerContainer>[]>(
    () => [
      {
        id: 'name',
        name: t('docker_col_container'),
        sortable: true,
        grow: 2,
        selector: (container) => container.name,
        searchText: (container) => `${container.name} ${container.id} ${container.image ?? ''}`,
        cell: (container) => (
          <div style={{ padding: '6px 0', minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>{container.name}</div>
            <div className="font-monospace" style={{ fontSize: 11, color: MUTED }} title={container.id}>
              {container.id.slice(0, 12)}
              {container.image ? ` · ${container.image}` : ''}
            </div>
          </div>
        ),
      },
      {
        id: 'status',
        name: t('docker_col_status'),
        sortable: true,
        selector: (container) => container.status,
        searchText: (container) => `${container.status} ${container.health ?? ''}`,
        cell: (container) => (
          <span className="d-inline-flex align-items-center gap-2 flex-wrap">
            <Chip
              label={container.status}
              {...(STATUS_COLORS[container.status] ?? { color: '#6E6868', background: 'var(--progeo-track-soft)' })}
            />
            {container.health && (
              <span style={{ fontSize: 11.5, color: HEALTH_COLORS[container.health] ?? MUTED }}>{container.health}</span>
            )}
          </span>
        ),
      },
      {
        id: 'started',
        name: t('docker_col_started'),
        sortable: true,
        selector: (container) => (isRunning(container) ? (container.started_at ?? '') : ''),
        cell: (container) =>
          isRunning(container) && container.started_at ? (
            <span title={container.started_at}>{formatRelativeTime(container.started_at)}</span>
          ) : (
            <span style={{ color: MUTED }}>–</span>
          ),
      },
      {
        id: 'actions',
        name: '',
        right: true,
        width: '190px',
        cell: (container) => {
          const action = busy[container.id];
          const running = isRunning(container);
          const startStop = running ? 'stop' : 'start';
          return (
            <div className="d-inline-flex gap-2 align-items-center">
              {action && <Spinner animation="border" size="sm" />}
              <button
                type="button"
                title={t(`docker_action_${startStop}`)}
                aria-label={t(`docker_action_${startStop}`)}
                disabled={Boolean(action)}
                onClick={() => run(container, startStop)}
                style={iconButtonStyle(Boolean(action))}
              >
                {running ? <PauseFill size={15} /> : <PlayFill size={15} />}
              </button>
              <button
                type="button"
                title={t('docker_action_restart')}
                aria-label={t('docker_action_restart')}
                disabled={Boolean(action)}
                onClick={() => setConfirm({ container, action: 'restart' })}
                style={iconButtonStyle(Boolean(action))}
              >
                <BootstrapReboot size={14} />
              </button>
              <button
                type="button"
                title={t('docker_action_logs')}
                aria-label={t('docker_action_logs')}
                onClick={() => loadLogs(container, logs?.tail ?? LOG_TAILS[1])}
                style={iconButtonStyle(false)}
              >
                <FileText size={14} />
              </button>
              <DeleteIconButton
                label={running ? t('docker_remove_running_hint') : t('docker_action_remove')}
                disabled={running || Boolean(action)}
                onClick={() => setConfirm({ container, action: 'remove' })}
              />
            </div>
          );
        },
      },
    ],
    // run/loadLogs only use refs, setters and t.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, busy, logs?.tail],
  );

  const runningCount = containers?.filter(isRunning).length ?? 0;

  return (
    <div className="d-flex flex-column gap-3">
      <PanelCard
        title={t('docker_title')}
        actions={
          <div className="d-flex align-items-center gap-2">
            {containers && (
              <span style={{ fontSize: 12.5, color: MUTED }}>
                {t('docker_running_count', { running: runningCount, total: containers.length })}
              </span>
            )}
            <PillButton
              variant="ghost"
              icon={refreshing ? <Spinner animation="border" size="sm" /> : <ArrowClockwise size={14} />}
              label={t('docker_refresh')}
              disabled={refreshing}
              onClick={load}
            />
          </div>
        }
      >
        {loadError && (
          <div style={{ color: '#C44D26', fontSize: 13, marginBottom: 10 }}>
            {t('docker_load_failed')}: {loadError}
          </div>
        )}
        {containers == null ? (
          !loadError && (
            <div className="d-flex justify-content-center py-4">
              <Spinner animation="border" />
            </div>
          )
        ) : (
          <SearchableDataTable
            columns={columns}
            data={containers}
            keyField="id"
            defaultSortFieldId="name"
            highlightOnHover
            noDataComponent={<div style={{ color: MUTED, padding: 14 }}>{t('docker_none')}</div>}
          />
        )}
      </PanelCard>

      <ConfirmDialog
        show={confirm !== null}
        title={confirm ? t(`docker_confirm_${confirm.action}_title`) : ''}
        message={confirm ? t(`docker_confirm_${confirm.action}_message`, { name: confirm.container.name }) : ''}
        confirmLabel={confirm ? t(`docker_action_${confirm.action}`) : ''}
        cancelLabel={t('docker_cancel')}
        danger={confirm?.action === 'remove'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) {
            run(confirm.container, confirm.action);
          }
          setConfirm(null);
        }}
      />

      <Modal show={logs !== null} onHide={() => setLogs(null)} size="xl" scrollable>
        <Modal.Header closeButton>
          <Modal.Title style={{ fontSize: 16 }}>
            {logs ? t('docker_logs_title', { name: logs.container.name }) : ''}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {logs && (
            <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
              <span style={{ fontSize: 12.5, color: MUTED }}>{t('docker_logs_tail')}</span>
              <SegmentedControl
                options={LOG_TAILS.map((tail) => ({ value: String(tail), label: String(tail) }))}
                value={String(logs.tail)}
                onChange={(value) => loadLogs(logs.container, Number(value))}
              />
              <span style={{ flex: 1 }} />
              <PillButton
                variant="ghost"
                icon={<ArrowClockwise size={13} />}
                label={t('docker_refresh')}
                disabled={logs.text == null}
                onClick={() => loadLogs(logs.container, logs.tail)}
              />
              <PillButton
                variant="ghost"
                icon={<Clipboard size={13} />}
                label={t('docker_logs_copy')}
                disabled={!logs.text}
                onClick={copyLogs}
              />
            </div>
          )}
          {logs?.text == null ? (
            <div className="d-flex justify-content-center py-4">
              <Spinner animation="border" />
            </div>
          ) : (
            <pre
              ref={logRef}
              data-testid="docker-logs"
              style={{
                maxHeight: '65vh',
                overflow: 'auto',
                background: '#07223A',
                color: '#E6EEF5',
                borderRadius: 10,
                padding: 12,
                fontSize: 11.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                margin: 0,
              }}
            >
              {logs.text || t('docker_logs_empty')}
            </pre>
          )}
        </Modal.Body>
      </Modal>
    </div>
  );
};

export default DockerStatusView;
