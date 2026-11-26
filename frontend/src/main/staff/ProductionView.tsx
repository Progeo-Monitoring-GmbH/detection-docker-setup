import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { CheckLg, ExclamationTriangle, Wrench, XLg } from 'react-bootstrap-icons';
import Plot from 'react-plotly.js';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showRequestError } from '../../components/ui/Snackbar.jsx';
import { FullscreenButton, FullscreenFrame, useFullscreen } from '../../components/ui/kit/Fullscreen';
import KpiStrip from '../../components/ui/kit/KpiStrip';
import PanelCard from '../../components/ui/kit/PanelCard';
import PillButton from '../../components/ui/kit/PillButton';
import PillSelect from '../../components/ui/kit/PillSelect';
import SearchableDataTable, { ROW_CLICK, type SearchableColumn } from '../../components/ui/kit/SearchableDataTable';
import { byNumberNullsLast } from '../../components/ui/kit/sortNullsLast';
import { PlotlyTouchScroll } from '../../components/ui/wheelZoom';
import { formatDate } from '../dateFormat';
import { repeatedTestId } from '../../testIds';
import { ACCENT, baseLayout, plotConfig, SERIES } from './chartTheme';
import {
  formatMeters,
  formatReading,
  MEASURES,
  orderLabel,
  orderNumber,
  overviewUrl,
  QS_URL,
  share,
  type FlaggedEntry,
  type ProductionOrder,
  type ProductionOverview,
  type ProductionRoll,
  type QsStatus,
} from './production';
import './StaffInsights.css';
import './ProductionView.css';

const ALL = 'all';
const CHART_HEIGHT = 260;

const Progress = ({ value, testId }: { value: number; testId?: string }) => (
  <span className="pr-progress" data-testid={testId}>
    <span className="pr-progress-bar" style={{ width: `${Math.round(value * 100)}%` }} />
  </span>
);

const QsBadge = ({ entry }: { entry: FlaggedEntry }) => {
  const { t } = useTranslation();
  if (!entry.qs) {
    return <span className="pr-qs pr-qs--draft">{t('pr_qs_draft')}</span>;
  }
  const kind = { OK: 'ok', Nacharbeit: 'rework', Prüfen: 'open' }[entry.qs.status];
  const title = entry.qs.manuell
    ? t('pr_qs_by', { user: entry.qs.von ?? '–', date: formatDate(entry.qs.am) })
    : t('pr_qs_automatic');
  return (
    <span className={`pr-qs pr-qs--${kind}`} title={title}>
      {t(`pr_qs_${kind}`)}
      {entry.qs.manuell && entry.qs.status !== 'Prüfen' ? ' ✓' : ''}
    </span>
  );
};

/** The meters per day: measuring band and lead cable side by side. */
const MetersChart = ({ data }: { data: ProductionOverview }) => {
  const { t, i18n } = useTranslation();
  const days = data.tage.map((day) => day.datum);
  const labels = data.tage.map((day) => formatDate(day.datum, 'weekdayDayMonth'));
  const hover = (kind: string) =>
    `%{customdata[0]}<br>${kind}: <b>%{y:.1f} m</b><br>${t('pr_chart_sensors')}: %{customdata[1]}<extra></extra>`;
  const custom = data.tage.map((day, index) => [labels[index], day.sensoren]);
  return (
    <PlotlyTouchScroll>
      <Plot
        data={[
          {
            type: 'bar',
            name: t('pr_messband'),
            x: days,
            y: data.tage.map((day) => day.messband_m),
            marker: { color: SERIES },
            customdata: custom,
            hovertemplate: hover(t('pr_messband')),
          },
          {
            type: 'bar',
            name: t('pr_vorlauf'),
            x: days,
            y: data.tage.map((day) => day.vorlauf_m),
            marker: { color: ACCENT },
            customdata: custom,
            hovertemplate: hover(t('pr_vorlauf')),
          },
        ]}
        layout={baseLayout(CHART_HEIGHT, {
          barmode: 'group',
          showlegend: true,
          legend: { orientation: 'h', x: 0, y: 1.12 },
          margin: { l: 8, r: 12, t: 28, b: 8 },
          separators: i18n.language.startsWith('de') ? ',.' : '.,',
          xaxis: { type: 'category', tickvals: days, ticktext: labels },
          yaxis: { title: { text: t('pr_meters') }, rangemode: 'tozero' },
        })}
        config={plotConfig}
        style={{ width: '100%' }}
        useResizeHandler
      />
    </PlotlyTouchScroll>
  );
};

/**
 * /staff/production/ - how the factory's production of dm sensors is going
 * (the manuSensor app's Produktion area, docs/fertigung.md): the figures and
 * meters per day, the sensors with bad values and those with warnings - and
 * their QS check, which counts for the production bonus - the orders and the
 * rolls. Staff only (as GET /v1/werk/produktion/).
 */
const ProductionView = () => {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [order, setOrder] = useState<string | null>(null);
  const [data, setData] = useState<ProductionOverview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const chartFullscreen = useFullscreen();
  const locale = i18n.language;

  const load = useCallback(() => {
    axiosConfig.perform_get(
      auth,
      overviewUrl(order),
      (response: { data: ProductionOverview }) => setData(response.data),
      (error: unknown) => showRequestError(enqueueSnackbar, t('pr_load_failed'), error),
    );
  }, [auth, enqueueSnackbar, order, t]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = useCallback(
    (ids: string[], qs: QsStatus) => {
      if (!ids.length) {
        return;
      }
      setBusy(true);
      axiosConfig.perform_post(
        auth,
        QS_URL,
        { sensor_record_ids: ids, qs },
        () => {
          setBusy(false);
          setSelected(new Set());
          enqueueSnackbar(t('pr_qs_saved', { count: ids.length }), { variant: 'success' });
          load();
        },
        (error: unknown) => {
          setBusy(false);
          showRequestError(enqueueSnackbar, t('pr_qs_failed'), error);
        },
      );
    },
    [auth, enqueueSnackbar, load, t],
  );

  const flaggedColumns = useCallback(
    (kind: 'bad' | 'warning'): SearchableColumn<FlaggedEntry>[] => [
      {
        id: 'auftrag',
        name: t('pr_col_order'),
        selector: (row) => row.auftrag_id,
        format: (row) => orderNumber(row.auftrag_id),
        sortable: true,
        width: '110px',
      },
      {
        id: 'sensor',
        name: t('pr_col_sensor'),
        selector: (row) => row.sensor,
        cell: (row) => (
          <span className="fw-bold" {...repeatedTestId(`production-${kind}-sensor`, row.sensor_record_id)}>
            dm {Number(row.sensor)}
          </span>
        ),
        searchText: (row) => `dm ${Number(row.sensor)} ${row.sensor}`,
        sortable: true,
        width: '100px',
      },
      ...MEASURES.map(
        (name): SearchableColumn<FlaggedEntry> => ({
          id: name,
          name: t(`pr_col_${name}`),
          selector: (row) => row.werte[name].ohm ?? -1,
          cell: (row) => (
            <span className={`pr-value pr-value--${row.werte[name].flag}`}>
              {formatReading(row.werte[name], locale, t('pr_open'))}
            </span>
          ),
          searchText: (row) => formatReading(row.werte[name], locale, t('pr_open')),
          sortFunction: byNumberNullsLast((row: FlaggedEntry) => row.werte[name].ohm),
          sortable: true,
          right: true,
        }),
      ),
      {
        id: 'erfasst_am',
        name: t('pr_col_recorded'),
        selector: (row) => row.erfasst_am,
        cell: (row) => <span className="fw-bold">{formatDate(row.erfasst_am)}</span>,
        searchText: (row) => formatDate(row.erfasst_am),
        sortable: true,
        grow: 1.3,
      },
      {
        id: 'kuerzel',
        name: t('pr_col_initials'),
        selector: (row) => row.kuerzel ?? '',
        format: (row) => row.kuerzel ?? '–',
        sortable: true,
        width: '80px',
      },
      {
        id: 'blatt',
        name: t('pr_col_sheet'),
        selector: (row) => row.blatt ?? 0,
        cell: (row) =>
          row.blatt == null ? (
            <span className="text-muted">{t('pr_sheet_draft')}</span>
          ) : (
            <span title={row.bestaetigt ? t('pr_confirmed_hint') : undefined}>
              {row.blatt}
              {row.bestaetigt && <CheckLg className="ms-1" size={12} />}
            </span>
          ),
        sortable: true,
        width: '80px',
      },
      {
        id: 'qs',
        name: t('pr_col_qs'),
        selector: (row) => row.qs?.status ?? '',
        cell: (row) => <QsBadge entry={row} />,
        searchText: (row) => (row.qs ? row.qs.status : t('pr_qs_draft')),
        sortable: true,
        width: '120px',
      },
      {
        id: 'actions',
        name: '',
        width: '120px',
        ignoreRowClick: true,
        cell: (row) =>
          row.blatt == null ? null : (
            <span className="pr-row-actions">
              <button
                type="button"
                className="progeo-icon-button"
                title={t('pr_qs_set_ok')}
                aria-label={t('pr_qs_set_ok')}
                disabled={busy || row.qs?.status === 'OK'}
                onClick={() => decide([row.sensor_record_id], 'OK')}
                {...repeatedTestId('production-qs-ok', row.sensor_record_id)}
              >
                <CheckLg size={14} />
              </button>
              <button
                type="button"
                className="progeo-icon-button"
                title={t('pr_qs_set_rework')}
                aria-label={t('pr_qs_set_rework')}
                disabled={busy || row.qs?.status === 'Nacharbeit'}
                onClick={() => decide([row.sensor_record_id], 'Nacharbeit')}
                {...repeatedTestId('production-qs-rework', row.sensor_record_id)}
              >
                <Wrench size={13} />
              </button>
              {row.qs?.manuell && (
                <button
                  type="button"
                  className="progeo-icon-button"
                  title={t('pr_qs_undo')}
                  aria-label={t('pr_qs_undo')}
                  disabled={busy}
                  onClick={() => decide([row.sensor_record_id], 'Prüfen')}
                  {...repeatedTestId('production-qs-undo', row.sensor_record_id)}
                >
                  <XLg size={12} />
                </button>
              )}
            </span>
          ),
      },
    ],
    [busy, decide, locale, t],
  );
  const badColumns = useMemo(() => flaggedColumns('bad'), [flaggedColumns]);
  const warningColumns = useMemo(() => flaggedColumns('warning'), [flaggedColumns]);

  const orderColumns = useMemo<SearchableColumn<ProductionOrder>[]>(
    () => [
      {
        id: 'auftrag',
        name: t('pr_col_order'),
        selector: (row) => row.nr ?? 0,
        cell: (row) => (
          <span className="fw-bold" {...ROW_CLICK} {...repeatedTestId('production-order-row', row.id)}>
            {orderLabel(row)}
          </span>
        ),
        searchText: (row) => `${orderLabel(row)} ${row.auftrag_id}`,
        sortable: true,
        grow: 2,
      },
      {
        id: 'fortschritt',
        name: t('pr_col_progress'),
        selector: (row) => share(row.erfasst, row.gesamt),
        cell: (row) => (
          <span className="pr-progress-cell" {...ROW_CLICK}>
            <Progress value={share(row.erfasst, row.gesamt)} />
            <span className="small text-muted" {...ROW_CLICK}>
              {row.erfasst} / {row.gesamt ?? '?'}
            </span>
          </span>
        ),
        sortable: true,
        grow: 1.5,
      },
      {
        id: 'blaetter',
        name: t('pr_col_sheets'),
        selector: (row) => row.blaetter_freigegeben,
        format: (row) => `${row.blaetter_freigegeben} / ${row.blaetter ?? '?'}`,
        sortable: true,
        right: true,
      },
      {
        id: 'fehler',
        name: t('pr_col_bad'),
        selector: (row) => row.fehler,
        cell: (row) => <span className={row.fehler ? 'pr-count--bad' : undefined}>{row.fehler}</span>,
        sortable: true,
        right: true,
      },
      {
        id: 'warnungen',
        name: t('pr_col_warnings'),
        selector: (row) => row.warnungen,
        cell: (row) => <span className={row.warnungen ? 'pr-count--warn' : undefined}>{row.warnungen}</span>,
        sortable: true,
        right: true,
      },
      {
        id: 'qs_offen',
        name: t('pr_col_qs_open'),
        selector: (row) => row.qs_offen,
        cell: (row) => <span className={row.qs_offen ? 'fw-bold' : undefined}>{row.qs_offen}</span>,
        sortable: true,
        right: true,
      },
      {
        id: 'zuletzt',
        name: t('pr_col_last'),
        selector: (row) => row.zuletzt ?? '',
        cell: (row) => <span className="fw-bold">{row.zuletzt ? formatDate(row.zuletzt) : '–'}</span>,
        sortable: true,
        grow: 1.3,
      },
    ],
    [t],
  );

  const rollColumns = useMemo<SearchableColumn<ProductionRoll>[]>(
    () => [
      {
        id: 'nummer',
        name: t('pr_col_roll'),
        selector: (row) => row.nummer,
        cell: (row) => (
          <span className="fw-bold" {...repeatedTestId('production-roll', row.nummer)}>
            {row.nummer}
          </span>
        ),
        searchText: (row) => row.nummer,
        sortable: true,
      },
      {
        id: 'typ',
        name: t('pr_col_roll_type'),
        selector: (row) => row.typ,
        format: (row) => `${t(`pr_${row.typ}`)}${row.kabeltyp ? ` · ${row.kabeltyp}` : ''}`,
        sortable: true,
        grow: 1.3,
      },
      {
        id: 'rest',
        name: t('pr_col_rest'),
        selector: (row) => row.rest_m ?? -1,
        cell: (row) =>
          row.leer ? (
            <span className="pr-qs pr-qs--draft">{t('pr_roll_empty')}</span>
          ) : (
            <span className="pr-progress-cell">
              <Progress value={share(row.rest_m ?? 0, row.nennlaenge_m)} />
              <span className="small">
                <b>{formatMeters(row.rest_m, locale)}</b> / {formatMeters(row.nennlaenge_m, locale)}
              </span>
            </span>
          ),
        sortFunction: byNumberNullsLast((row: ProductionRoll) => (row.leer ? 0 : row.rest_m)),
        sortable: true,
        grow: 1.6,
      },
      {
        id: 'sensoren',
        name: t('pr_col_roll_sensors'),
        selector: (row) => row.sensoren,
        sortable: true,
        right: true,
      },
      {
        id: 'zuletzt',
        name: t('pr_col_last'),
        selector: (row) => row.zuletzt?.am ?? '',
        cell: (row) =>
          row.zuletzt ? (
            <span>
              <b>{formatDate(row.zuletzt.am)}</b>
              <span className="small text-muted d-block">
                {[row.zuletzt.auftrag_id && orderNumber(row.zuletzt.auftrag_id), row.zuletzt.benutzer]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          ) : (
            '–'
          ),
        searchText: (row) => `${row.zuletzt?.auftrag_id ?? ''} ${row.zuletzt?.benutzer ?? ''}`,
        sortable: true,
        grow: 1.6,
      },
      {
        id: 'fotos',
        name: t('pr_col_photos'),
        selector: (row) => row.fotos.length,
        cell: (row) =>
          row.fotos.length ? (
            row.fotos.length
          ) : (
            <span className="pr-count--warn" title={t('pr_roll_no_photo')}>
              <ExclamationTriangle size={12} /> 0
            </span>
          ),
        sortable: true,
        right: true,
        width: '80px',
      },
    ],
    [locale, t],
  );

  const flagged = data?.auffaellig ?? [];
  const bad = flagged.filter((row) => row.stufe === 'fehler');
  const warnings = flagged.filter((row) => row.stufe === 'warnung');
  const selectable = (rows: FlaggedEntry[]) => ({
    rowKey: (row: FlaggedEntry) => row.sensor_record_id,
    selected,
    onChange: (next: Set<string>) =>
      // Drafts have no QS check yet.
      setSelected(new Set([...next].filter((id) => rows.some((row) => row.sensor_record_id === id && row.blatt != null)))),
    toggleOnRowClick: false,
  });
  const selectedIds = [...selected];
  const bulkActions = (testId: string) =>
    selectedIds.length ? (
      <span className="pr-bulk">
        <span className="small">{t('pr_selected', { count: selectedIds.length })}</span>
        <PillButton
          label={t('pr_qs_set_ok')}
          icon={<CheckLg size={12} />}
          variant="accent"
          disabled={busy}
          onClick={() => decide(selectedIds, 'OK')}
          testId={`${testId}-ok`}
        />
        <PillButton
          label={t('pr_qs_set_rework')}
          icon={<Wrench size={12} />}
          variant="ghost"
          disabled={busy}
          onClick={() => decide(selectedIds, 'Nacharbeit')}
          testId={`${testId}-rework`}
        />
      </span>
    ) : (
      <span className="small text-muted">{t('pr_qs_hint')}</span>
    );

  const counts = data?.kennzahlen;
  const kpis = counts
    ? [
        {
          label: t('pr_kpi_band_today'),
          value: formatMeters(counts.messband_heute_m, locale),
          note: t('pr_kpi_sensors_today', { count: counts.sensoren_heute }),
          testId: 'production-kpi-messband',
        },
        {
          label: t('pr_kpi_lead_today'),
          value: formatMeters(counts.vorlauf_heute_m, locale),
          testId: 'production-kpi-vorlauf',
        },
        {
          label: t('pr_kpi_recorded'),
          value: `${counts.erfasst} / ${counts.gesamt}`,
          testId: 'production-kpi-erfasst',
        },
        {
          label: t('pr_kpi_bad'),
          value: String(counts.fehler),
          valueColor: counts.fehler ? 'var(--pr-bad)' : undefined,
          testId: 'production-kpi-fehler',
        },
        {
          label: t('pr_kpi_warnings'),
          value: String(counts.warnungen),
          valueColor: counts.warnungen ? 'var(--pr-warn)' : undefined,
          testId: 'production-kpi-warnungen',
        },
        {
          label: t('pr_kpi_qs_open'),
          value: String(counts.qs_offen),
          testId: 'production-kpi-qs_offen',
        },
        { label: t('pr_kpi_orders'), value: String(counts.auftraege), testId: 'production-kpi-auftraege' },
      ]
    : [];
  const tableLabels = {
    placeholder: t('pr_search'),
    count: (shown: number, total: number) => t('pr_search_count', { shown, total }),
    noMatches: t('pr_no_matches'),
  };
  const flaggedTable = (rows: FlaggedEntry[], testId: string, columns: SearchableColumn<FlaggedEntry>[]) => (
    <SearchableDataTable
      columns={columns}
      data={rows}
      testId={testId}
      labels={tableLabels}
      selection={selectable(rows)}
      toolbar={bulkActions(testId)}
      defaultSortFieldId="erfasst_am"
      defaultSortAsc={false}
      pagination
      paginationPerPage={25}
      mobileColumns={['sensor', 'qs', 'actions']}
      columnWidthsKey={testId}
      noDataComponent={<div className="progeo-table-empty">{t('pr_none_flagged')}</div>}
    />
  );

  return (
    <div className="staff-insights pr-page" data-testid="page-production">
      <PanelCard
        title={t('pr_title')}
        testId="production-header"
        actions={
          <PillSelect
            label={t('pr_col_order')}
            options={[
              { value: ALL, label: t('pr_all_orders') },
              ...(data?.auftraege ?? []).map((row) => ({ value: row.id, label: orderLabel(row) })),
              // The chosen order stays selectable while it has nothing to show.
              ...(order && !data?.auftraege.some((row) => row.id === order) ? [{ value: order, label: order }] : []),
            ]}
            value={order ?? ALL}
            onChange={(value) => setOrder(value === ALL ? null : value)}
            testId="production-order"
          />
        }
      >
        <div className="staff-insights-subtitle">{t('pr_subtitle')}</div>
      </PanelCard>
      {data === null ? (
        <Spinner size="sm" />
      ) : (
        <>
          <PanelCard bodyClassName="staff-insights-strip" testId="production-kpis">
            <KpiStrip tiles={kpis} />
          </PanelCard>
          <FullscreenFrame state={chartFullscreen}>
            <PanelCard
              title={t('pr_chart_title', { days: data.tage.length })}
              testId="production-chart"
              foldable={false}
              actions={<FullscreenButton state={chartFullscreen} testId="production-chart-fullscreen" />}
            >
              <MetersChart data={data} />
            </PanelCard>
          </FullscreenFrame>
          <PanelCard title={t('pr_bad_title', { count: bad.length })} testId="production-bad-panel">
            <div className="staff-insights-subtitle mb-2">{t('pr_bad_hint')}</div>
            {flaggedTable(bad, 'production-bad', badColumns)}
          </PanelCard>
          <PanelCard title={t('pr_warnings_title', { count: warnings.length })} testId="production-warnings-panel">
            <div className="staff-insights-subtitle mb-2">{t('pr_warnings_hint')}</div>
            {flaggedTable(warnings, 'production-warnings', warningColumns)}
          </PanelCard>
          <PanelCard title={t('pr_orders_title')} testId="production-orders-panel">
            <SearchableDataTable
              columns={orderColumns}
              data={data.auftraege}
              testId="production-orders"
              labels={tableLabels}
              onRowClicked={(row) => setOrder(row.id === order ? null : row.id)}
              pointerOnHover
              mobileColumns={['auftrag', 'fortschritt']}
              columnWidthsKey="production_orders"
              noDataComponent={<div className="progeo-table-empty">{t('pr_no_orders')}</div>}
            />
          </PanelCard>
          <PanelCard title={t('pr_rolls_title')} testId="production-rolls-panel">
            <SearchableDataTable
              columns={rollColumns}
              data={data.rollen}
              testId="production-rolls"
              labels={tableLabels}
              pagination
              paginationPerPage={25}
              mobileColumns={['nummer', 'rest']}
              columnWidthsKey="production_rolls"
              noDataComponent={<div className="progeo-table-empty">{t('pr_no_rolls')}</div>}
            />
          </PanelCard>
        </>
      )}
    </div>
  );
};

export default ProductionView;
