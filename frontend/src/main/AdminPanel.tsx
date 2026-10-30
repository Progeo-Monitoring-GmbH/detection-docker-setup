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
const MUTED = '#8B8383';

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

const formatTime = (value?: string | Date | null) => {
  if (!value) {
    return '-';
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
};

/** "attachment; filename="x.tar"" -> x.tar */
const attachmentName = (header?: string | null) => header?.match(/filename="?([^";]+)"?/)?.[1] ?? null;

// ------------------------------------------------------------------- storage

const UsageBar = ({ percent }: { percent: number | null }) => {
  const value = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const color = value >= 90 ? '#C44D26' : value >= 75 ? '#D99A1E' : 'var(--progeo-blue)';
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--progeo-track)', overflow: 'hidden' }}>
      <div style={{ width: `${value}%`, height: '100%', background: color, transition: 'width .4s ease' }} />
    </div>
  );
};

const StorageTile = ({
  label,
  value,
  percent,
  lines,
}: {
  label: string;
  value: string;
  percent: number | null;
  lines: Array<string | null>;
}) => (
  <div
    style={{
      background: 'var(--progeo-surface)',
      borderRadius: 14,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minWidth: 0,
    }}
  >
    <div style={{ fontSize: 13, color: '#6E6868' }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 500, color: 'var(--progeo-blue)', letterSpacing: '-0.02em' }}>
      {value}
    </div>
    {percent != null && <UsageBar percent={percent} />}
    {lines.filter(Boolean).map((line) => (
      <div key={line} style={{ fontSize: 12, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
      title={t('admin_storage_title')}
      actions={
        <>
          <span style={{ fontSize: 12, color: MUTED }}>
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
          />
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <StorageTile
          label={t('admin_storage_root')}
          value={rootPercent != null ? `${rootPercent.toFixed(0)} %` : '-'}
          percent={rootPercent}
          lines={[
            t('admin_storage_used', { used: bytesToReadable(root.used_bytes), total: bytesToReadable(root.total_bytes) }),
            t('admin_storage_free', { free: bytesToReadable(root.available_bytes) }),
          ]}
        />
        <StorageTile
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
              <span style={{ color: '#9A7208' }}> {t('admin_lageplan_widened', { days: usedDays })}</span>
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
    <PanelCard title={t('admin_lageplan_title')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <PillSelect
          label={t('admin_lageplan_period')}
          options={LAGEPLAN_PERIODS.map((value) => ({
            value,
            label: t('admin_days', { count: Number(value) }),
          }))}
          value={days}
          onChange={setDays}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm d-inline-flex align-items-center gap-2"
          style={{ borderRadius: 'var(--progeo-radius-pill)', height: 32, padding: '0 16px' }}
          disabled={busy}
          onClick={exportLageplans}
        >
          {busy ? <Spinner size="sm" animation="border" /> : <FileEarmarkZip />}
          {t('admin_lageplan_download')}
        </button>
        {result && <span style={{ fontSize: 12.5, color: '#3F7A1C' }}>{result}</span>}
      </div>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>{t('admin_lageplan_hint')}</div>
    </PanelCard>
  );
};

// ---------------------------------------------------------------------- logs

const STATUS_STYLE: Record<LogStreamStatus, { color: string; bg: string; key: string }> = {
  live: { color: '#3F7A1C', bg: '#EBF4E3', key: 'admin_logs_status_live' },
  connecting: { color: '#6E6868', bg: '#EFECEC', key: 'admin_logs_status_connecting' },
  reconnecting: { color: '#9A7208', bg: '#FBF3DE', key: 'admin_logs_status_reconnecting' },
  denied: { color: '#C44D26', bg: '#FBE9E3', key: 'admin_logs_status_denied' },
};

const StatusPill = ({ status }: { status: LogStreamStatus }) => {
  const { t } = useTranslation();
  const style = STATUS_STYLE[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11.5,
        fontWeight: 600,
        color: style.color,
        background: style.bg,
        borderRadius: 'var(--progeo-radius-pill)',
        padding: '3px 10px',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: style.color,
          animation: status === 'live' ? 'admin-pulse 2s ease-in-out infinite' : undefined,
        }}
      />
      {t(style.key)}
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
      title={t('admin_logs_title')}
      actions={
        <>
          <StatusPill status={status} />
          <PillButton variant="ghost" label={t('admin_refresh')} icon={<ArrowClockwise />} onClick={refreshFiles} />
        </>
      }
    >
      <style>
        {'@keyframes admin-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }' +
          '@media (max-width: 860px) { .admin-logs-grid { grid-template-columns: minmax(0, 1fr) !important } }'}
      </style>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)', gap: 14 }} className="admin-logs-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ position: 'relative' }}>
            <Search style={{ position: 'absolute', left: 10, top: 9, color: MUTED }} size={13} />
            <Form.Control
              size="sm"
              placeholder={t('admin_logs_filter_files')}
              value={fileFilter}
              onChange={(event) => setFileFilter(event.target.value)}
              style={{ paddingLeft: 30, borderRadius: 'var(--progeo-radius-pill)' }}
            />
          </div>
          <div style={{ maxHeight: 560, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {files === null ? (
              <div className="text-muted small py-3 text-center">
                <Spinner size="sm" animation="border" />
              </div>
            ) : shownFiles.length === 0 ? (
              <div className="text-muted small py-3">{t('admin_logs_no_files')}</div>
            ) : (
              shownFiles.map((item) => {
                const active = item.file === selected;
                return (
                  <button
                    key={item.file}
                    type="button"
                    onClick={() => choose(item.file)}
                    title={item.path}
                    style={{
                      textAlign: 'left',
                      border: 'none',
                      borderRadius: 10,
                      padding: '7px 10px',
                      background: active ? 'var(--progeo-surface)' : 'transparent',
                      boxShadow: active ? 'var(--progeo-shadow-chrome)' : 'none',
                      color: active ? 'var(--progeo-blue)' : '#3A3535',
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: 12.5, fontWeight: active ? 600 : 500, wordBreak: 'break-all' }}>
                      {item.file}
                    </div>
                    <div style={{ fontSize: 11, color: MUTED }}>
                      {bytesToReadable(item.size_bytes)} · {formatTime(item.modified_at)}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 200px' }}>
              <Search style={{ position: 'absolute', left: 10, top: 9, color: MUTED }} size={13} />
              <Form.Control
                size="sm"
                placeholder={t('admin_logs_filter_lines')}
                value={lineFilter}
                onChange={(event) => setLineFilter(event.target.value)}
                style={{ paddingLeft: 30, borderRadius: 'var(--progeo-radius-pill)' }}
              />
            </div>
            <PillSelect
              label={t('admin_logs_lines')}
              options={LOG_LINES.map((value) => ({ value, label: value }))}
              value={lines}
              onChange={setLines}
            />
            <Form.Check
              type="switch"
              id="admin-logs-follow"
              className="small mb-0"
              label={t('admin_logs_follow')}
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />
            <Form.Check
              type="switch"
              id="admin-logs-wrap"
              className="small mb-0"
              label={t('admin_logs_wrap')}
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
            />
            <PillButton
              variant="ghost"
              label={paused != null ? t('admin_logs_resume') : t('admin_logs_pause')}
              icon={paused != null ? <PlayFill /> : <PauseFill />}
              disabled={content == null}
              onClick={() => setPaused((current) => (current != null ? null : (content ?? '')))}
            />
            <PillButton
              variant="ghost"
              label={t('admin_logs_download')}
              icon={<Download />}
              disabled={!text}
              onClick={() =>
                downloadBlob(new Blob([text], { type: 'text/plain' }), (selected.split('/').pop() || 'log') + '.txt')
              }
            />
          </div>

          <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: MUTED, flexWrap: 'wrap' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {meta?.path || selected || '-'}
            </span>
            {meta && <span>{bytesToReadable(meta.size_bytes)}</span>}
            {updatedAt && <span>{t('admin_logs_updated', { time: formatTime(updatedAt) })}</span>}
            {filtered.matches != null && <span>{t('admin_logs_matches', { count: filtered.matches })}</span>}
            {paused != null && <span style={{ color: '#9A7208', fontWeight: 600 }}>{t('admin_logs_paused')}</span>}
          </div>
          {error && <div style={{ fontSize: 12, color: '#C44D26' }}>{error}</div>}

          <pre
            ref={viewerRef}
            onScroll={onScroll}
            style={{
              background: '#101419',
              color: '#d9e2ec',
              borderRadius: 12,
              padding: '12px 14px',
              height: 560,
              margin: 0,
              overflow: 'auto',
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: wrap ? 'pre-wrap' : 'pre',
              wordBreak: wrap ? 'break-all' : 'normal',
            }}
          >
            {content == null && selected ? t('ui_loading') : filtered.text || t('admin_logs_empty')}
          </pre>
          {!follow && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <PillButton variant="ghost" label={t('admin_logs_jump_end')} onClick={() => setFollow(true)} />
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24 }}>
      <h2 className="mb-0">{t('admin_title')}</h2>
      <StorageSection />
      <LageplanExportSection />
      <LogsSection />
    </div>
  );
};

export default AdminPanelView;
