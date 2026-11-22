import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { ArrowLeft } from 'react-bootstrap-icons';
import Plot from 'react-plotly.js';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showRequestError } from '../../components/ui/Snackbar.jsx';
import KpiStrip from '../../components/ui/kit/KpiStrip';
import PanelCard from '../../components/ui/kit/PanelCard';
import PillButton from '../../components/ui/kit/PillButton';
import PillSelect from '../../components/ui/kit/PillSelect';
import SearchableDataTable, { progeoTableStyles, type SearchableColumn } from '../../components/ui/kit/SearchableDataTable';
import { PlotlyTouchScroll } from '../../components/ui/wheelZoom';
import { formatDate } from '../dateFormat';
import { ACCENT, baseLayout, CATEGORICAL, formatDuration, median, OTHER, plotConfig, SEQUENTIAL, SERIES } from './chartTheme';
import './StaffInsights.css';

/** One tab session of GET /v1/activity/sessions/ (helper/activity.sessions). */
type Session = {
  session: string;
  user_id: number;
  username: string;
  start: string;
  end: string | null;
  duration_ms: number;
  visible_ms: number;
  views: number;
  pages: number;
  clicks: number;
  logins: number;
};

type SessionsResponse = { days: number; enabled: boolean; retention_days: number; limit: number; sessions: Session[] };

/** A path of GET /v1/activity/summary/ (helper/activity.summary). */
type PageRow = { path: string; views: number; users: number; avg_ms: number | null; median_ms: number | null; total_ms: number | null };

/** `clients` of the summary: per value the number of sessions, most used first ('' = unknown). */
type ClientCount = { value: string; sessions: number };
const CLIENT_FIELDS = ['device', 'browser', 'language', 'screen'] as const;
type ClientField = (typeof CLIENT_FIELDS)[number];
type Clients = { sessions: number } & Record<ClientField, ClientCount[]>;
type Summary = { pages: PageRow[]; clients: Clients | null };

type ActivityEvent = { kind: 'login' | 'page' | 'click' | 'client'; path: string; target: string; duration_ms: number | null; at: string };
type SessionDetail = { session: string; user_id: number; username: string; events: ActivityEvent[] };

/** GET /v1/activity/messaging/ (matrix_accounts.stats, login_links.usage_stats). */
type MessagingStats = {
  matrix: { enabled: boolean; server_accounts: number | null; connected: number; active_7d: number; active_30d: number; primary: number };
  login_links: Record<'24h' | '7d' | '30d', Record<'login' | 'invite' | 'reset' | 'matrix' | 'migration' | 'total', number>>;
};

const LINK_PERIODS = ['24h', '7d', '30d'] as const;

/** Chat accounts and the use of one-time login links - independent of the usage tracking. */
const MessagingStatsPanel = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const [stats, setStats] = useState<MessagingStats | null>(null);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/activity/messaging/',
      (response) => setStats(response?.data as MessagingStats),
      () => {},
    );
  }, [auth]);

  if (!stats) {
    return null;
  }
  const { matrix, login_links: links } = stats;
  const number = (value: number | null) => (value === null ? '–' : String(value));
  // One flat row of tiles (chat accounts, then login links) under the title.
  return (
    <PanelCard title={t('ua_messaging_title')} testId="user-activity-messaging" bodyClassName="staff-insights-strip">
      <KpiStrip
        testId="user-activity-messaging-kpis"
        tiles={[
          ...(matrix.enabled
            ? [
                { label: t('ua_matrix_server_accounts'), value: number(matrix.server_accounts), note: t('ua_matrix_server_accounts_note'), testId: 'ua-matrix-server' },
                { label: t('ua_matrix_connected'), value: number(matrix.connected), note: t('ua_matrix_connected_note'), testId: 'ua-matrix-connected' },
                { label: t('ua_matrix_active'), value: number(matrix.active_7d), note: t('ua_matrix_active_note', { count: matrix.active_30d }), testId: 'ua-matrix-active' },
                { label: t('ua_matrix_primary'), value: number(matrix.primary), note: t('ua_matrix_primary_note'), testId: 'ua-matrix-primary' },
              ]
            : []),
          ...LINK_PERIODS.map((period) => ({
            label: t(`ua_links_${period}`),
            value: String(links[period].total),
            note: t('ua_links_note', {
              login: links[period].login,
              invite: links[period].invite,
              reset: links[period].reset,
              matrix: links[period].matrix,
              migration: links[period].migration,
            }),
            testId: `ua-links-${period}`,
          })),
        ]}
      />
    </PanelCard>
  );
};

const PERIODS = ['7', '30', '90', '180'];
const TOP_PAGES = 12;
/** Height of the overview charts - one row of the grid lines up. */
const CHART_HEIGHT = 210;
const MINUTE = 60 * 1000;
/** Session length classes of the histogram (upper bounds, ms). */
const LENGTH_BINS: Array<{ max: number; label: string }> = [
  { max: MINUTE, label: '< 1 min' },
  { max: 5 * MINUTE, label: '1–5 min' },
  { max: 15 * MINUTE, label: '5–15 min' },
  { max: 30 * MINUTE, label: '15–30 min' },
  { max: 60 * MINUTE, label: '30–60 min' },
  { max: 120 * MINUTE, label: '1–2 h' },
  { max: Number.POSITIVE_INFINITY, label: '> 2 h' },
];

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Ranked horizontal bars of the visible time per page (minutes), largest on top. */
const PageTimeChart = ({ rows, height }: { rows: Array<{ path: string; total_ms: number; views: number; median_ms?: number | null }>; height?: number }) => {
  const { t } = useTranslation();
  const shown = [...rows].sort((a, b) => b.total_ms - a.total_ms).slice(0, TOP_PAGES).reverse();
  if (!shown.length) {
    return <div className="small text-muted py-2">{t('ua_no_pages')}</div>;
  }
  return (
    <PlotlyTouchScroll>
      <Plot
        data={[
          {
            type: 'bar',
            orientation: 'h',
            x: shown.map((row) => row.total_ms / MINUTE),
            y: shown.map((row) => row.path),
            marker: { color: SERIES },
            customdata: shown.map((row) => [formatDuration(row.total_ms), row.views, formatDuration(row.median_ms ?? null)]),
            hovertemplate: `%{y}<br>%{customdata[0]} · ${t('ua_views')}: %{customdata[1]}<br>${t('ua_median_view')}: %{customdata[2]}<extra></extra>`,
          },
        ]}
        layout={baseLayout(height ?? Math.max(CHART_HEIGHT, shown.length * 18 + 36), {
          xaxis: { title: { text: t('ua_minutes') }, rangemode: 'tozero' },
          yaxis: { gridcolor: 'transparent', ticks: '' },
        })}
        config={plotConfig}
        style={{ width: '100%' }}
        useResizeHandler
      />
    </PlotlyTouchScroll>
  );
};

/**
 * The shares of one client field as a pie: the most used values in the fixed
 * colour order, everything after them folded into "Other" (grey, last). Each
 * slice is labelled with its name and share - never told apart by colour alone.
 */
const ClientPie = ({ field, counts }: { field: ClientField; counts: ClientCount[] }) => {
  const { t } = useTranslation();
  const named = (value: string) => value || t('ua_client_unknown');
  const top = counts.slice(0, CATEGORICAL.length);
  const rest = counts.slice(CATEGORICAL.length).reduce((sum, row) => sum + row.sessions, 0);
  const slices = [
    ...top.map((row, index) => ({ label: named(row.value), sessions: row.sessions, color: CATEGORICAL[index] })),
    ...(rest > 0 ? [{ label: t('ua_client_other'), sessions: rest, color: OTHER }] : []),
  ];
  return (
    <PanelCard title={t(`ua_client_${field}`)} testId={`user-activity-client-${field}`}>
      {slices.length === 0 ? (
        <div className="small text-muted py-2" data-testid={`user-activity-client-${field}-empty`}>
          {t('ua_client_none')}
        </div>
      ) : (
        <PlotlyTouchScroll>
          <Plot
            data={[
              {
                type: 'pie',
                labels: slices.map((slice) => slice.label),
                values: slices.map((slice) => slice.sessions),
                // The order given (most used first, clockwise from the top), not Plotly's.
                sort: false,
                direction: 'clockwise',
                marker: { colors: slices.map((slice) => slice.color), line: { color: '#f3f1f0', width: 2 } },
                textinfo: 'label+percent',
                textposition: 'outside',
                automargin: true,
                hovertemplate: `%{label}<br>%{value} ${t('ua_sessions')} · %{percent}<extra></extra>`,
              },
            ]}
            layout={baseLayout(CHART_HEIGHT, { margin: { l: 8, r: 8, t: 16, b: 16 } })}
            config={plotConfig}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </PlotlyTouchScroll>
      )}
    </PanelCard>
  );
};

// ------------------------------------------------------------------ all sessions

const AllSessions = ({
  sessions,
  pages,
  clients,
  days,
  loadedAt,
  onOpen,
}: {
  sessions: SessionsResponse;
  pages: PageRow[];
  /** What the sessions were opened with (null: an older backend). */
  clients: Clients | null;
  days: number;
  /** When the sessions arrived (epoch ms) - the last day of the per-day chart. */
  loadedAt: number;
  onOpen: (session: string) => void;
}) => {
  const { t } = useTranslation();
  const rows = sessions.sessions;
  const users = new Set(rows.map((row) => row.user_id)).size;

  const kpis = [
    { label: t('ua_kpi_sessions'), value: String(rows.length), note: rows.length >= sessions.limit ? t('ua_kpi_limit', { count: sessions.limit }) : undefined },
    { label: t('ua_kpi_users'), value: String(users) },
    { label: t('ua_kpi_median_stay'), value: formatDuration(median(rows.map((row) => row.duration_ms))) },
    { label: t('ua_kpi_median_visible'), value: formatDuration(median(rows.map((row) => row.visible_ms))) },
    { label: t('ua_kpi_median_pages'), value: String(Math.round(median(rows.map((row) => row.pages)) * 10) / 10) },
  ];

  // Sessions per day - every day of the period, empty ones too.
  const perDay = useMemo(() => {
    const counts = new Map<string, number>();
    const today = new Date(loadedAt);
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
      counts.set(dayKey(day), 0);
    }
    rows.forEach((row) => {
      const key = dayKey(new Date(row.start));
      if (counts.has(key)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    });
    return [...counts.entries()];
  }, [rows, days, loadedAt]);

  const lengths = useMemo(
    () =>
      LENGTH_BINS.map(
        (bin, index) =>
          rows.filter((row) => row.duration_ms < bin.max && (index === 0 || row.duration_ms >= LENGTH_BINS[index - 1].max))
            .length,
      ),
    [rows],
  );

  // Session starts by weekday (Mon first) and hour, local time.
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) =>
        new Date(2024, 0, 1 + index).toLocaleDateString(undefined, { weekday: 'short' }),
      ),
    [],
  );
  const heat = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    rows.forEach((row) => {
      const start = new Date(row.start);
      grid[(start.getDay() + 6) % 7][start.getHours()] += 1;
    });
    return grid;
  }, [rows]);

  const columns: SearchableColumn<Session>[] = [
    { name: t('ua_col_user'), selector: (row) => row.username, sortable: true, grow: 1.4 },
    {
      id: 'start',
      name: t('ua_col_start'),
      selector: (row) => row.start,
      sortable: true,
      grow: 1.4,
      cell: (row) => <span className="small">{formatDate(row.start, 'dateTime')}</span>,
    },
    { name: t('ua_col_stay'), selector: (row) => row.duration_ms, sortable: true, right: true, cell: (row) => <span className="small staff-insights-num">{formatDuration(row.duration_ms)}</span> },
    { name: t('ua_col_visible'), selector: (row) => row.visible_ms, sortable: true, right: true, cell: (row) => <span className="small staff-insights-num">{formatDuration(row.visible_ms)}</span> },
    { name: t('ua_views'), selector: (row) => row.views, sortable: true, right: true },
    { name: t('ua_col_pages'), selector: (row) => row.pages, sortable: true, right: true },
    { name: t('ua_col_clicks'), selector: (row) => row.clicks, sortable: true, right: true },
  ];

  return (
    <>
      <KpiStrip tiles={kpis} testId="user-activity-kpis" />

      <div className="staff-insights-grid">
        <PanelCard title={t('ua_per_day')} testId="user-activity-per-day">
          <PlotlyTouchScroll>
            <Plot
              data={[
                {
                  type: 'bar',
                  x: perDay.map(([day]) => day),
                  y: perDay.map(([, count]) => count),
                  marker: { color: SERIES },
                  hovertemplate: `%{x|%a %d.%m.}<br>%{y} ${t('ua_sessions')}<extra></extra>`,
                },
              ]}
              layout={baseLayout(CHART_HEIGHT, { xaxis: { type: 'date', tickformat: '%d.%m.' }, yaxis: { rangemode: 'tozero', tickformat: 'd' } })}
              config={plotConfig}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </PlotlyTouchScroll>
        </PanelCard>

        <PanelCard title={t('ua_lengths')} testId="user-activity-lengths">
          <PlotlyTouchScroll>
            <Plot
              data={[
                {
                  type: 'bar',
                  x: LENGTH_BINS.map((bin) => bin.label),
                  y: lengths,
                  marker: { color: SERIES },
                  hovertemplate: `%{x}<br>%{y} ${t('ua_sessions')}<extra></extra>`,
                },
              ]}
              layout={baseLayout(CHART_HEIGHT, { xaxis: { title: { text: t('ua_col_stay') } }, yaxis: { rangemode: 'tozero', tickformat: 'd' } })}
              config={plotConfig}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </PlotlyTouchScroll>
        </PanelCard>

        <PanelCard title={t('ua_page_time', { count: TOP_PAGES })} testId="user-activity-pages">
          <PageTimeChart
            rows={pages.map((row) => ({ path: row.path, total_ms: row.total_ms ?? 0, views: row.views, median_ms: row.median_ms }))}
          />
          <div className="staff-insights-note">{t('ua_page_time_note')}</div>
        </PanelCard>

        <PanelCard title={t('ua_when')} testId="user-activity-when">
          <PlotlyTouchScroll>
            <Plot
              data={[
                {
                  type: 'heatmap',
                  z: heat,
                  x: Array.from({ length: 24 }, (_, hour) => hour),
                  y: weekdays,
                  colorscale: SEQUENTIAL,
                  zmin: 0,
                  xgap: 2,
                  ygap: 2,
                  colorbar: { thickness: 10, outlinewidth: 0, tickfont: { size: 10 } },
                  hovertemplate: `%{y} %{x}:00–%{x}:59<br>%{z} ${t('ua_sessions')}<extra></extra>`,
                },
              ]}
              layout={baseLayout(CHART_HEIGHT, {
                xaxis: { title: { text: t('ua_hour') }, dtick: 3, gridcolor: 'transparent' },
                yaxis: { autorange: 'reversed', gridcolor: 'transparent' },
              })}
              config={plotConfig}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </PlotlyTouchScroll>
        </PanelCard>
      </div>

      {clients && (
        <>
          <div className="staff-insights-grid staff-insights-grid--pies" data-testid="user-activity-clients">
            {CLIENT_FIELDS.map((field) => (
              <ClientPie key={field} field={field} counts={clients[field]} />
            ))}
          </div>
          <div className="staff-insights-note" data-testid="user-activity-clients-note">
            {t('ua_client_note', { count: clients.sessions })}
          </div>
        </>
      )}

      <PanelCard title={t('ua_sessions_title')} testId="user-activity-sessions">
        <SearchableDataTable
          columns={columns}
          data={rows}
          keyField="session"
          defaultSortFieldId="start"
          defaultSortAsc={false}
          pagination
          paginationPerPage={25}
          customStyles={progeoTableStyles}
          dense
          highlightOnHover
          pointerOnHover
          onRowClicked={(row) => onOpen(row.session)}
          noDataComponent={<div className="small text-muted py-3">{t('ua_no_sessions')}</div>}
          testId="user-activity-session-rows"
        />
        <div className="staff-insights-note">{t('ua_open_hint')}</div>
      </PanelCard>
    </>
  );
};

// ------------------------------------------------------------------ one session

/** The session's user and start, shown in the page header. */
type SessionHead = { username: string; at: string | undefined };

const OneSession = ({ session, onLoaded }: { session: string; onLoaded: (head: SessionHead) => void }) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      `/v1/activity/session/?session=${encodeURIComponent(session)}`,
      (response) => {
        const loaded = (response?.data ?? null) as SessionDetail | null;
        setDetail(loaded);
        if (loaded) {
          onLoaded({ username: loaded.username, at: loaded.events[0]?.at });
        }
      },
      (error) => {
        setMissing(true);
        showRequestError(enqueueSnackbar, t('ua_session_failed'), error);
      },
    );
  }, [auth, enqueueSnackbar, onLoaded, session, t]);

  const events = useMemo(() => detail?.events ?? [], [detail]);
  const views = events.filter((event) => event.kind === 'page');
  const clicks = events.filter((event) => event.kind === 'click');
  // The pages in the order they were first opened - the timeline's rows.
  const paths = [...new Set(events.filter((event) => event.kind === 'page' || event.kind === 'click').map((event) => event.path))];
  const startMs = events.length ? Date.parse(events[0].at) : 0;
  const endMs = events.reduce((end, event) => Math.max(end, Date.parse(event.at) + (event.duration_ms ?? 0)), startMs);
  const visible = views.reduce((sum, event) => sum + (event.duration_ms ?? 0), 0);
  const perPage = paths
    .map((path) => {
      const ofPath = views.filter((event) => event.path === path);
      return { path, total_ms: ofPath.reduce((sum, event) => sum + (event.duration_ms ?? 0), 0), views: ofPath.length };
    })
    .filter((row) => row.views > 0);

  const columns: SearchableColumn<ActivityEvent & { index: number }>[] = [
    { name: t('ua_col_time'), selector: (row) => row.index, sortable: true, cell: (row) => <span className="small">{formatDate(row.at, 'dateTimeSeconds')}</span>, grow: 1.3 },
    { name: t('ua_col_kind'), selector: (row) => row.kind, sortable: true, cell: (row) => <span className="small">{t(`ua_kind_${row.kind}`)}</span> },
    { name: t('ua_col_page'), selector: (row) => row.path, sortable: true, grow: 2, cell: (row) => <code className="small">{row.path}</code> },
    { name: t('ua_col_element'), selector: (row) => row.target, sortable: true, grow: 1.5, cell: (row) => (row.target ? <code className="small">{row.kind === 'client' ? row.target.split('|').filter(Boolean).join(' · ') : row.target}</code> : <span className="text-muted">–</span>) },
    { name: t('ua_col_visible'), selector: (row) => row.duration_ms ?? -1, sortable: true, right: true, cell: (row) => <span className="small staff-insights-num">{row.kind === 'page' ? formatDuration(row.duration_ms) : '–'}</span> },
  ];

  return (
    <>
      {missing ? (
        <div className="small text-muted py-3" data-testid="user-activity-session-missing">{t('ua_session_missing')}</div>
      ) : !detail ? (
        <div className="staff-insights-placeholder"><Spinner animation="border" size="sm" /></div>
      ) : (
        <>
          <KpiStrip
            tiles={[
              { label: t('ua_col_stay'), value: formatDuration(endMs - startMs) },
              { label: t('ua_col_visible'), value: formatDuration(visible) },
              { label: t('ua_views'), value: String(views.length) },
              { label: t('ua_col_pages'), value: String(perPage.length) },
              { label: t('ua_col_clicks'), value: String(clicks.length) },
            ]}
            testId="user-activity-session-kpis"
          />

          <PanelCard title={t('ua_timeline')} testId="user-activity-timeline">
            <PlotlyTouchScroll>
              <Plot
                data={[
                  {
                    type: 'bar',
                    orientation: 'h',
                    name: t('ua_legend_visible'),
                    base: views.map((event) => event.at),
                    x: views.map((event) => Math.max(event.duration_ms ?? 0, 1000)),
                    y: views.map((event) => event.path),
                    marker: { color: SERIES },
                    width: 0.5,
                    customdata: views.map((event) => [formatDate(event.at, 'time'), formatDuration(event.duration_ms)]),
                    hovertemplate: `%{y}<br>%{customdata[0]} · %{customdata[1]}<extra></extra>`,
                  },
                  {
                    type: 'scatter',
                    mode: 'markers',
                    name: t('ua_legend_click'),
                    x: clicks.map((event) => event.at),
                    y: clicks.map((event) => event.path),
                    marker: { color: ACCENT, size: 9, line: { color: '#ffffff', width: 2 } },
                    customdata: clicks.map((event) => [formatDate(event.at, 'dateTimeSeconds'), event.target || '–']),
                    hovertemplate: `%{customdata[1]}<br>%{customdata[0]}<extra>${t('ua_legend_click')}</extra>`,
                  },
                ]}
                layout={baseLayout(Math.max(CHART_HEIGHT, paths.length * 26 + 60), {
                  showlegend: true,
                  legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 12 } },
                  margin: { l: 8, r: 12, t: 28, b: 8 },
                  barmode: 'overlay',
                  xaxis: { type: 'date', tickformat: '%H:%M' },
                  yaxis: { type: 'category', categoryorder: 'array', categoryarray: [...paths].reverse(), gridcolor: 'transparent', ticks: '' },
                })}
                config={plotConfig}
                style={{ width: '100%' }}
                useResizeHandler
              />
            </PlotlyTouchScroll>
            <div className="staff-insights-note">{t('ua_timeline_note')}</div>
          </PanelCard>

          <div className="staff-insights-grid">
            <PanelCard title={t('ua_session_pages')} testId="user-activity-session-pages">
              <PageTimeChart rows={perPage} />
            </PanelCard>
            <PanelCard title={t('ua_events')} testId="user-activity-events">
              <SearchableDataTable
                columns={columns}
                data={events.map((event, index) => ({ ...event, index }))}
                keyField="index"
                pagination
                paginationPerPage={25}
                customStyles={progeoTableStyles}
                dense
                testId="user-activity-event-rows"
              />
            </PanelCard>
          </div>
        </>
      )}
    </>
  );
};

// ------------------------------------------------------------------ page

/**
 * Staff (sidebar: User activity): the usage analysis of the tracked users
 * (ProgeoActivity, only with their consent, never staff) - all sessions of a
 * period (how long they stayed, which pages, when) or one session with its
 * timeline (?session=<id>), and what the sessions were opened with (device,
 * browser, language, screen - one pie each). Data: GET /v1/activity/sessions/, /summary/ and
 * /session/.
 */
const UserActivityView = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [searchParams, setSearchParams] = useSearchParams();
  const session = searchParams.get('session');
  const [days, setDays] = useState('30');
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [summary, setSummary] = useState<Summary>({ pages: [], clients: null });
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState(0);
  const [sessionHead, setSessionHead] = useState<(SessionHead & { session: string }) | null>(null);
  const onSessionLoaded = useCallback(
    (loaded: SessionHead) => session && setSessionHead({ ...loaded, session }),
    [session],
  );

  const load = useCallback(() => {
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) {
        setLoading(false);
      }
    };
    const failed = (error: unknown) => {
      showRequestError(enqueueSnackbar, t('ua_load_failed'), error);
      done();
    };
    void axiosConfig.perform_get(
      auth,
      `/v1/activity/sessions/?days=${days}`,
      (response) => {
        setSessions((response?.data ?? null) as SessionsResponse | null);
        setLoadedAt(Date.now());
        done();
      },
      failed,
    );
    void axiosConfig.perform_get(
      auth,
      `/v1/activity/summary/?days=${days}`,
      (response) => {
        const data = (response?.data ?? {}) as Partial<Summary>;
        setSummary({ pages: data.pages ?? [], clients: data.clients ?? null });
        done();
      },
      failed,
    );
  }, [auth, days, enqueueSnackbar, t]);
  useEffect(load, [load]);

  const openSession = (next: string | null) =>
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next) {
          params.set('session', next);
        } else {
          params.delete('session');
        }
        return params;
      },
      { replace: false },
    );

  const head = sessionHead?.session === session ? sessionHead : null;

  return (
    <div className="staff-insights" data-testid="page-user-activity">
      <PanelCard
        title={t('ua_title')}
        testId="user-activity-header"
        actions={
          session ? (
            <PillButton label={t('ua_back')} icon={<ArrowLeft />} onClick={() => openSession(null)} variant="ghost" testId="user-activity-back" />
          ) : (
            <PillSelect
              label={t('ua_period')}
              options={PERIODS.map((value) => ({ value, label: t('ua_days', { count: Number(value) }) }))}
              value={days}
              onChange={(value) => {
                if (value !== days) {
                  setLoading(true);
                  setDays(value);
                }
              }}
              testId="user-activity-days"
            />
          )
        }
      >
        <div className="staff-insights-subtitle">
          {!session
            ? t('ua_intro')
            : head
              ? <>{t('ua_session_of', { user: head.username, at: formatDate(head.at, 'dateTime') })} · <code>{session}</code></>
              : <code>{session}</code>}
        </div>
        {sessions && !sessions.enabled && (
          <Alert variant="warning" className="mt-2 mb-0 small" data-testid="user-activity-disabled">
            {t('ua_disabled', { days: sessions.retention_days })}
          </Alert>
        )}
      </PanelCard>

      {!session && <MessagingStatsPanel />}

      {session ? (
        <OneSession key={session} session={session} onLoaded={onSessionLoaded} />
      ) : !sessions ? (
        <div className="staff-insights-placeholder">{loading && <Spinner animation="border" size="sm" />}</div>
      ) : (
        // A stack of its own: the page's gap does not reach into this wrapper.
        <div className={loading ? 'staff-insights staff-insights-busy' : 'staff-insights'}>
          <AllSessions sessions={sessions} pages={summary.pages} clients={summary.clients} days={Number(days)} loadedAt={loadedAt} onOpen={openSession} />
        </div>
      )}
    </div>
  );
};

export default UserActivityView;
