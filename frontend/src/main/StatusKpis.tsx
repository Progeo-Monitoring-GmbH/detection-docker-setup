import { useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import KpiStrip from '../components/ui/kit/KpiStrip';
import { formatRelativeTime } from './dateFormat';
import {
  type AnlageState,
  formatMinutes,
  nextMeasurementOf,
  severityColor,
  type VerdachtsstelleCluster,
} from './locationStatusData';
import { anlageColor, kpiSummaryOf } from './locationStatusViewData';

type Anlage = { state: AnlageState; last: number | null; next: number | null };

const Loading = () => {
  const { t } = useTranslation();
  return (
    <div
      className="d-flex justify-content-center py-5 text-muted"
      data-testid="status-loading"
    >
      <Spinner animation="border" className="me-2" /> {t('ui_loading')}
    </div>
  );
};

/** Now, every 30 s while `ticking` - at least `now`. */
const useTileClock = (ticking: boolean, now: number) => {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) {
      return undefined;
    }
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return Math.max(now, clock);
};

/** The Anlage tile's note: its newest measurement and (online) when the
 * next one is expected - or how long it is overdue. */
const useAnlageNote = (anlage: Anlage, tileNow: number) => {
  const { t } = useTranslation();
  const upcoming =
    anlage.state === 'online' ? nextMeasurementOf(anlage.next, tileNow) : null;
  const last =
    anlage.last != null
      ? t('status_kpi_anlage_last', {
          time: formatRelativeTime(anlage.last, tileNow),
        })
      : t('status_kpi_anlage_last_unknown');
  const next =
    upcoming &&
    t(
      upcoming.overdue
        ? 'status_kpi_anlage_next_overdue'
        : 'status_kpi_anlage_next',
      { time: formatMinutes(upcoming.minutes) },
    );
  return [last, next].filter(Boolean).join(' · ');
};

/** Object status, open Verdachtsstellen, highest reading and whether the
 * installation reports (a measurement in the last 24 h) - with the time
 * since its newest measurement. */
const StatusKpis = ({
  clusters,
  openSuspicions,
  threshold,
  anlage,
  now,
}: {
  clusters: VerdachtsstelleCluster[];
  /** The open Verdachtsstellen as the panel shows them (the computed
   * points); null: one per sensor. */
  openSuspicions: number | null;
  threshold: number | null;
  anlage: Anlage;
  now: number;
}) => {
  const { t } = useTranslation();
  // The Anlage tile counts down to the next measurement: its own clock,
  // so the rest of the page doesn't re-render every 30 s.
  const tileNow = useTileClock(
    anlage.state === 'online' && anlage.next != null,
    now,
  );
  const anlageNote = useAnlageNote(anlage, tileNow);
  const { worstSeverity, openCount, highestReading } = kpiSummaryOf(
    clusters,
    openSuspicions,
  );
  const hasReading = highestReading != null;
  const anlageLoading = anlage.state === 'loading';

  return (
    <KpiStrip
      testId="status-kpis"
      tiles={[
        {
          testId: 'status-kpi-objektstatus',
          label: t('status_kpi_objektstatus'),
          value: worstSeverity
            ? t(`ui_severity_${worstSeverity}` as const)
            : t('status_kpi_ok'),
          note: openCount
            ? t('status_kpi_note_open', { count: openCount })
            : t('status_kpi_note_none'),
          valueColor: severityColor(worstSeverity),
        },
        {
          testId: 'status-kpi-verdachtsstellen',
          label: t('status_kpi_verdachtsstellen'),
          value: String(openCount),
          unit: t('status_kpi_active_unit'),
        },
        {
          testId: 'status-kpi-max-value',
          label: t('status_kpi_max_value'),
          value: hasReading ? String(Math.round(highestReading)) : '–',
          unit: hasReading ? 'mV' : undefined,
          note:
            threshold != null
              ? t('status_kpi_max_value_threshold', { threshold })
              : undefined,
        },
        {
          testId: 'status-kpi-anlage',
          label: t('status_kpi_anlage'),
          value: anlageLoading
            ? '–'
            : t(`status_kpi_anlage_${anlage.state}` as const),
          note: anlageLoading ? undefined : anlageNote,
          valueColor: anlageColor(anlage.state),
        },
      ]}
    />
  );
};

/** The KPI strip - a spinner while the Verdachtsstellen or the history
 * load, nothing without permission to see them. */
export const StatusKpiSection = ({
  loading,
  denied,
  ...kpis
}: Parameters<typeof StatusKpis>[0] & {
  loading: boolean;
  denied: boolean;
}) => {
  if (loading) {
    return <Loading />;
  }
  return denied ? null : <StatusKpis {...kpis} />;
};
