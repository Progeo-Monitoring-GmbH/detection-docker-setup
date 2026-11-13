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
import { repeatedTestId } from '../testIds';
import './DockerStatusView.css';

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

/** The colours per tone: .docker-status-chip--<tone> / .docker-status-health--<tone> in DockerStatusView.css. */
type Tone = 'ok' | 'danger' | 'warn';
const STATUS_TONES: Record<string, Tone> = {
  running: 'ok',
  exited: 'danger',
  dead: 'danger',
  paused: 'warn',
  restarting: 'warn',
};
const HEALTH_TONES: Record<string, Tone> = { healthy: 'ok', unhealthy: 'danger', starting: 'warn' };

/** Without a tone (an unknown status) the chip is neutral grey. */
const Chip = ({ label, tone, testKey }: { label: string; tone?: Tone; testKey: string }) => (
  <span
    className={tone ? `docker-status-chip docker-status-chip--${tone}` : 'docker-status-chip'}
    {...repeatedTestId('docker-container-status', testKey)}
  >
    {label}
  </span>
);

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
          <div className="docker-status-container">
            <div className="docker-status-name" {...repeatedTestId('docker-container-name', container.id)}>{container.name}</div>
            <div className="font-monospace docker-status-id" title={container.id}>
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
            <Chip label={container.status} tone={STATUS_TONES[container.status]} testKey={container.id} />
            {container.health && (
              <span
                className={
                  HEALTH_TONES[container.health]
                    ? `docker-status-health docker-status-health--${HEALTH_TONES[container.health]}`
                    : 'docker-status-health'
                }
                {...repeatedTestId('docker-container-health', container.id)}
              >
                {container.health}
              </span>
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
            <span className="docker-status-muted">–</span>
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
                className="progeo-icon-button"
                {...repeatedTestId('docker-container-start-stop', container.id)}
              >
                {running ? <PauseFill size={15} /> : <PlayFill size={15} />}
              </button>
              <button
                type="button"
                title={t('docker_action_restart')}
                aria-label={t('docker_action_restart')}
                disabled={Boolean(action)}
                onClick={() => setConfirm({ container, action: 'restart' })}
                className="progeo-icon-button"
                {...repeatedTestId('docker-container-restart', container.id)}
              >
                <BootstrapReboot size={14} />
              </button>
              <button
                type="button"
                title={t('docker_action_logs')}
                aria-label={t('docker_action_logs')}
                onClick={() => loadLogs(container, logs?.tail ?? LOG_TAILS[1])}
                className="progeo-icon-button"
                {...repeatedTestId('docker-container-logs', container.id)}
              >
                <FileText size={14} />
              </button>
              <DeleteIconButton
                label={running ? t('docker_remove_running_hint') : t('docker_action_remove')}
                disabled={running || Boolean(action)}
                onClick={() => setConfirm({ container, action: 'remove' })}
                testId="docker-container-remove"
                testKey={container.id}
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
    <div className="d-flex flex-column gap-3" data-testid="page-docker">
      <PanelCard
        testId="docker-containers"
        title={t('docker_title')}
        actions={
          <div className="d-flex align-items-center gap-2">
            {containers && (
              <span className="docker-status-note" data-testid="docker-running-count">
                {t('docker_running_count', { running: runningCount, total: containers.length })}
              </span>
            )}
            <PillButton
              variant="ghost"
              icon={refreshing ? <Spinner animation="border" size="sm" /> : <ArrowClockwise size={14} />}
              label={t('docker_refresh')}
              disabled={refreshing}
              onClick={load}
              testId="docker-refresh"
            />
          </div>
        }
      >
        {loadError && (
          <div className="docker-status-error" data-testid="docker-error">
            {t('docker_load_failed')}: {loadError}
          </div>
        )}
        {containers == null ? (
          !loadError && (
            <div className="d-flex justify-content-center py-4" data-testid="docker-loading">
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
            testId="docker-table"
            noDataComponent={<div className="docker-status-muted docker-status-empty" data-testid="docker-empty">{t('docker_none')}</div>}
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
        testId="docker-confirm"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) {
            run(confirm.container, confirm.action);
          }
          setConfirm(null);
        }}
      />

      <Modal show={logs !== null} onHide={() => setLogs(null)} size="xl" scrollable data-testid="docker-logs-dialog">
        <Modal.Header closeButton>
          <Modal.Title className="docker-logs-title" data-testid="docker-logs-title">
            {logs ? t('docker_logs_title', { name: logs.container.name }) : ''}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {logs && (
            <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
              <span className="docker-status-note">{t('docker_logs_tail')}</span>
              <SegmentedControl
                options={LOG_TAILS.map((tail) => ({ value: String(tail), label: String(tail) }))}
                value={String(logs.tail)}
                onChange={(value) => loadLogs(logs.container, Number(value))}
                testId="docker-logs-tail"
              />
              <span className="docker-logs-spacer" />
              <PillButton
                variant="ghost"
                icon={<ArrowClockwise size={13} />}
                label={t('docker_refresh')}
                disabled={logs.text == null}
                onClick={() => loadLogs(logs.container, logs.tail)}
                testId="docker-logs-refresh"
              />
              <PillButton
                variant="ghost"
                icon={<Clipboard size={13} />}
                label={t('docker_logs_copy')}
                disabled={!logs.text}
                onClick={copyLogs}
                testId="docker-logs-copy"
              />
            </div>
          )}
          {logs?.text == null ? (
            <div className="d-flex justify-content-center py-4" data-testid="docker-logs-loading">
              <Spinner animation="border" />
            </div>
          ) : (
            <pre
              ref={logRef}
              data-testid="docker-logs"
              className="docker-logs"
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
