import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Form, Spinner } from 'react-bootstrap';
import { ArrowClockwise, Download, FileEarmarkZip, PauseFill, PlayFill, Search } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig.tsx';
import { downloadBlob } from '../download';
import { showErrorBar, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import PillSelect from '../components/ui/kit/PillSelect';
import useLogStream, { type LogStreamStatus } from './admin/useLogStream';
import { formatDate } from './dateFormat';
import { repeatedTestId } from '../testIds';
import './AdminPanel.css';

type DiskInfo = {
  filesystem?: string;
  mount?: string;
  path?: string;
  total_bytes?: number;
  used_bytes?: number;
  available_bytes?: number;
  used_percent?: string;
  directory_size_bytes?: number;
};

/** storage_info.json (tasks.collect_host_storage_info). */
type StorageInfo = {
  generated_at?: string;
  host?: { hostname?: string; kernel?: string };
  storage?: { root?: DiskInfo; media?: DiskInfo; logs?: DiskInfo };
};

const LAGEPLAN_PERIODS = ['1', '3', '7', '14', '30'];
const LOG_LINES = ['200', '500', '1000', '2000'];

const bytesToReadable = (value?: number) => {
  if (!Number.isFinite(value as number) || (value as number) < 0) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = Number(value);
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(val >= 10 ? 1 : 2)} ${units[idx]}`;
};

const formatTime = (value?: string | Date | null) => formatDate(value, 'dateTimeSeconds');

/** "attachment; filename="x.tar"" -> x.tar */
const attachmentName = (header?: string | null) => header?.match(/filename="?([^";]+)"?/)?.[1] ?? null;

// ------------------------------------------------------------------- storage

const UsageBar = ({ percent }: { percent: number | null }) => {
  const value = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const level = value >= 90 ? ' admin-usage-fill--danger' : value >= 75 ? ' admin-usage-fill--warn' : '';
  return (
    <div className="admin-usage-bar">
      <div className={`admin-usage-fill${level}`} style={{ width: `${value}%` }} />
    </div>
  );
};

const StorageTile = ({
  label,
  value,
  percent,
  lines,
  testKey,
}: {
  label: string;
  value: string;
  percent: number | null;
  lines: Array<string | null>;
  /** data-test-key of the tile (src/testIds.ts). */
  testKey: string;
}) => (
  <div className="admin-storage-tile" {...repeatedTestId('admin-storage-tile', testKey)}>
    <div className="admin-storage-label">{label}</div>
    <div className="admin-storage-value" {...repeatedTestId('admin-storage-tile-value', testKey)}>
      {value}
    </div>
    {percent != null && <UsageBar percent={percent} />}
    {lines.filter(Boolean).map((line) => (
      <div key={line} className="admin-storage-line">
        {line}
      </div>
    ))}
  </div>
);

const usedPercent = (disk?: DiskInfo) => {
  const fromText = Number.parseFloat(String(disk?.used_percent ?? ''));
  if (Number.isFinite(fromText)) {
    return fromText;
  }
  return disk?.total_bytes && disk.used_bytes != null ? (disk.used_bytes / disk.total_bytes) * 100 : null;
};

const StorageSection = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      void axiosConfig.perform_get(
        auth,
        `/v1/status/admin/storage_info/${refresh ? '?refresh=true' : ''}`,
        (response) => {
          const data = response?.data || {};
          setInfo((data.storage_info || {}) as StorageInfo);
          setLoading(false);
          if (refresh && data.refresh_task_id) {
            showSuccessBar(enqueueSnackbar, t('admin_storage_queued'));
          }
        },
        (error) => {
          setLoading(false);
          showRequestError(enqueueSnackbar, 'Could not load storage info', error);
        },
      );
    },
    [auth, enqueueSnackbar, t],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const storage = info?.storage || {};
  const root = storage.root || {};
  const media = storage.media || {};
  const logs = storage.logs || {};
  const rootPercent = usedPercent(root);
  const mediaPercent = usedPercent(media);

  return (
    <PanelCard
      testId="admin-storage"
      title={t('admin_storage_title')}
      actions={
        <>
          <span className="admin-muted" data-testid="admin-storage-host">
            {[info?.host?.hostname, info?.host?.kernel, info?.generated_at && t('admin_storage_generated', { time: formatTime(info.generated_at) })]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <PillButton
            variant="ghost"
            label={t('admin_refresh')}
            icon={loading ? <Spinner size="sm" animation="border" /> : <ArrowClockwise />}
            disabled={loading}
            onClick={() => load(true)}
            testId="admin-storage-refresh"
          />
        </>
      }
    >
      <div className="admin-storage-grid">
        <StorageTile
          testKey="root"
          label={t('admin_storage_root')}
          value={rootPercent != null ? `${rootPercent.toFixed(0)} %` : '-'}
          percent={rootPercent}
          lines={[
            t('admin_storage_used', { used: bytesToReadable(root.used_bytes), total: bytesToReadable(root.total_bytes) }),
            t('admin_storage_free', { free: bytesToReadable(root.available_bytes) }),
          ]}
        />
        <StorageTile
          testKey="media"
          label={t('admin_storage_media')}
          value={bytesToReadable(media.directory_size_bytes)}
          percent={mediaPercent}
          lines={[
            media.total_bytes
              ? t('admin_storage_used', { used: bytesToReadable(media.used_bytes), total: bytesToReadable(media.total_bytes) })
              : null,
            media.path ?? null,
          ]}
        />
        <StorageTile
          testKey="logs"
          label={t('admin_storage_logs')}
          value={bytesToReadable(logs.directory_size_bytes)}
          percent={null}
          lines={[logs.path ?? null]}
        />
      </div>
    </PanelCard>
  );
};

// ---------------------------------------------------------- Lageplan export

const LageplanExportSection = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReactNode>(null);

  const exportLageplans = () => {
    setBusy(true);
    setResult(null);
    void axiosConfig.perform_get(
      auth,
      `/v1/status/admin/lageplan_export/?days=${days}`,
      (response) => {
        const headers = response?.headers || {};
        const usedDays = Number(headers['x-lageplan-days'] ?? days);
        const count = Number(headers['x-lageplan-count'] ?? 0);
        downloadBlob(
          new Blob([response.data], { type: 'application/x-tar' }),
          attachmentName(headers['content-disposition']) ?? `lageplans_${usedDays}d.tar`,
        );
        setResult(
          <>
            {t('admin_lageplan_done', { count, days: usedDays })}
            {usedDays !== Number(days) && (
              <span className="admin-warning-text"> {t('admin_lageplan_widened', { days: usedDays })}</span>
            )}
          </>,
        );
        setBusy(false);
      },
      (error) => {
        setBusy(false);
        if (error?.response?.status === 404) {
          showErrorBar(enqueueSnackbar, t('admin_lageplan_none'));
        } else {
          showRequestError(enqueueSnackbar, 'Could not export Lageplans', error);
        }
      },
      { responseType: 'blob' },
    );
  };

  return (
    <PanelCard title={t('admin_lageplan_title')} testId="admin-lageplan">
      <div className="admin-lageplan-row">
        <PillSelect
          label={t('admin_lageplan_period')}
          options={LAGEPLAN_PERIODS.map((value) => ({
            value,
            label: t('admin_days', { count: Number(value) }),
          }))}
          value={days}
          onChange={setDays}
          testId="admin-lageplan-period"
        />
        <button
          type="button"
          className="btn btn-primary btn-sm d-inline-flex align-items-center gap-2 admin-lageplan-download"
          disabled={busy}
          onClick={exportLageplans}
          data-testid="admin-lageplan-download"
        >
          {busy ? <Spinner size="sm" animation="border" /> : <FileEarmarkZip />}
          {t('admin_lageplan_download')}
        </button>
        {result && <span className="admin-lageplan-result" data-testid="admin-lageplan-result">{result}</span>}
      </div>
      <div className="admin-muted admin-lageplan-hint">{t('admin_lageplan_hint')}</div>
    </PanelCard>
  );
};

// ---------------------------------------------------------------------- logs

/** The colours per status: .admin-status-pill--<status> in AdminPanel.css. */
const STATUS_KEY: Record<LogStreamStatus, string> = {
  live: 'admin_logs_status_live',
  connecting: 'admin_logs_status_connecting',
  reconnecting: 'admin_logs_status_reconnecting',
  denied: 'admin_logs_status_denied',
};

const StatusPill = ({ status }: { status: LogStreamStatus }) => {
  const { t } = useTranslation();
  return (
    <span className={`admin-status-pill admin-status-pill--${status}`} data-testid="admin-logs-status">
      <span className="admin-status-dot" />
      {t(STATUS_KEY[status])}
    </span>
  );
};

const LogsSection = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const [lines, setLines] = useState('500');
  const { status, files, selected, select, refreshFiles, content, meta, updatedAt, error } = useLogStream(
    auth,
    Number(lines),
  );
  const [fileFilter, setFileFilter] = useState('');
  const [lineFilter, setLineFilter] = useState('');
  const [paused, setPaused] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const viewerRef = useRef<HTMLPreElement>(null);

  const shownFiles = useMemo(() => {
    const needle = fileFilter.trim().toLowerCase();
    return (files ?? []).filter((item) => !needle || item.file.toLowerCase().includes(needle));
  }, [files, fileFilter]);

  const text = paused ?? content ?? '';
  const filtered = useMemo(() => {
    const needle = lineFilter.trim().toLowerCase();
    if (!needle) {
      return { text, matches: null as number | null };
    }
    const kept = text.split('\n').filter((line) => line.toLowerCase().includes(needle));
    return { text: kept.join('\n'), matches: kept.length };
  }, [text, lineFilter]);

  // Follow the end while it is in view; scrolling up stops following.
  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && follow) {
      viewer.scrollTop = viewer.scrollHeight;
    }
  }, [filtered.text, follow]);

  const onScroll = () => {
    const viewer = viewerRef.current;
    if (viewer) {
      setFollow(viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 24);
    }
  };

  const choose = (file: string) => {
    setPaused(null);
    setFollow(true);
    select(file);
  };

  return (
    <PanelCard
      testId="admin-logs"
      title={t('admin_logs_title')}
      actions={
        <>
          <StatusPill status={status} />
          <PillButton variant="ghost" label={t('admin_refresh')} icon={<ArrowClockwise />} onClick={refreshFiles} testId="admin-logs-refresh" />
        </>
      }
    >
      <div className="admin-logs-grid">
        <div className="admin-logs-column">
          <div className="admin-search">
            <Search className="admin-search-icon" size={13} />
            <Form.Control
              size="sm"
              placeholder={t('admin_logs_filter_files')}
              value={fileFilter}
              onChange={(event) => setFileFilter(event.target.value)}
              className="admin-search-input"
              data-testid="admin-logs-file-filter"
            />
          </div>
          <div className="admin-log-files" data-testid="admin-logs-files">
            {files === null ? (
              <div className="text-muted small py-3 text-center" data-testid="admin-logs-files-loading">
                <Spinner size="sm" animation="border" />
              </div>
            ) : shownFiles.length === 0 ? (
              <div className="text-muted small py-3" data-testid="admin-logs-files-empty">{t('admin_logs_no_files')}</div>
            ) : (
              shownFiles.map((item) => {
                const active = item.file === selected;
                return (
                  <button
                    key={item.file}
                    type="button"
                    onClick={() => choose(item.file)}
                    title={item.path}
                    className={active ? 'admin-log-file admin-log-file--active' : 'admin-log-file'}
                    {...repeatedTestId('admin-logs-file', item.file)}
                  >
                    <div className="admin-log-file-name">
                      {item.file}
                    </div>
                    <div className="admin-log-file-meta">
                      {bytesToReadable(item.size_bytes)} · {formatTime(item.modified_at)}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="admin-logs-column">
          <div className="admin-logs-toolbar" data-testid="admin-logs-toolbar">
            <div className="admin-search admin-search--grow">
              <Search className="admin-search-icon" size={13} />
              <Form.Control
                size="sm"
                placeholder={t('admin_logs_filter_lines')}
                value={lineFilter}
                onChange={(event) => setLineFilter(event.target.value)}
                className="admin-search-input"
                data-testid="admin-logs-line-filter"
              />
            </div>
            <PillSelect
              label={t('admin_logs_lines')}
              options={LOG_LINES.map((value) => ({ value, label: value }))}
              value={lines}
              onChange={setLines}
              testId="admin-logs-lines"
            />
            <Form.Check
              type="switch"
              id="admin-logs-follow"
              className="small mb-0"
              label={t('admin_logs_follow')}
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
              data-testid="admin-logs-follow"
            />
            <Form.Check
              type="switch"
              id="admin-logs-wrap"
              className="small mb-0"
              label={t('admin_logs_wrap')}
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
              data-testid="admin-logs-wrap"
            />
            <PillButton
              variant="ghost"
              label={paused != null ? t('admin_logs_resume') : t('admin_logs_pause')}
              icon={paused != null ? <PlayFill /> : <PauseFill />}
              disabled={content == null}
              onClick={() => setPaused((current) => (current != null ? null : (content ?? '')))}
              testId="admin-logs-pause"
            />
            <PillButton
              variant="ghost"
              label={t('admin_logs_download')}
              icon={<Download />}
              disabled={!text}
              onClick={() =>
                downloadBlob(new Blob([text], { type: 'text/plain' }), (selected.split('/').pop() || 'log') + '.txt')
              }
              testId="admin-logs-download"
            />
          </div>

          <div className="admin-logs-meta" data-testid="admin-logs-meta">
            <span className="admin-logs-path" data-testid="admin-logs-path">
              {meta?.path || selected || '-'}
            </span>
            {meta && <span>{bytesToReadable(meta.size_bytes)}</span>}
            {updatedAt && <span>{t('admin_logs_updated', { time: formatTime(updatedAt) })}</span>}
            {filtered.matches != null && <span data-testid="admin-logs-matches">{t('admin_logs_matches', { count: filtered.matches })}</span>}
            {paused != null && <span className="admin-logs-paused" data-testid="admin-logs-paused">{t('admin_logs_paused')}</span>}
          </div>
          {error && <div className="admin-logs-error" data-testid="admin-logs-error">{error}</div>}

          <pre
            ref={viewerRef}
            onScroll={onScroll}
            className={wrap ? 'admin-log-viewer admin-log-viewer--wrap' : 'admin-log-viewer'}
            data-testid="admin-logs-viewer"
          >
            {content == null && selected ? t('ui_loading') : filtered.text || t('admin_logs_empty')}
          </pre>
          {!follow && (
            <div className="admin-logs-end">
              <PillButton variant="ghost" label={t('admin_logs_jump_end')} onClick={() => setFollow(true)} testId="admin-logs-jump-end" />
            </div>
          )}
        </div>
      </div>
    </PanelCard>
  );
};

/** Admin Panel (/admin/panel/, module_admin_enabled): host storage, the
 * Lageplan export and the live log viewer. */
const AdminPanelView = () => {
  const { t } = useTranslation();
  return (
    <div className="admin-panel" data-testid="page-admin-panel">
      <h2 className="mb-0">{t('admin_title')}</h2>
      <StorageSection />
      <LageplanExportSection />
      <LogsSection />
    </div>
  );
};

export default AdminPanelView;
