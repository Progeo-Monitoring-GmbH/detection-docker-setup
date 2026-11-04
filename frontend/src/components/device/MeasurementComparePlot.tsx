import React from 'react';
import { Button, Card, Spinner } from 'react-bootstrap';
import Plot from 'react-plotly.js';
import { useTranslation } from 'react-i18next';
import { XLg } from 'react-bootstrap-icons';
import { parseTimestamp } from '../../main/alarmUtils';
import { formatDate } from '../../main/dateFormat';
import { plotTheme } from '../../styles/plotTheme';
import { usePlotlyWheelZoom, useWheelHint, WheelZoomHint } from '../ui/wheelZoom';
import { frameAt } from './FrameSlider';
import { nearestRow, potentialsOf, signedBands } from './measurementBands';
import type { MeasurementCompareRow } from './MeasurementSamplesCompareChart';

type MeasurementComparePlotProps = {
  /** The shown period's measurements (as the measurements chart has them). */
  rows: MeasurementCompareRow[];
  /** The same period `offsetMs` earlier. */
  pastRows: MeasurementCompareRow[];
  /** The frame slider's time (ms); null: the newest measurement. */
  time: number | null;
  offsetMs: number;
  /** The offset, e.g. "vor 7 Tagen". */
  label: string;
  loading: boolean;
  /** Ends the comparison. */
  onClose: () => void;
};

const MIN_MAX_COLOR = 'rgba(153, 27, 27, 0.25)';
const DEVIATION_COLOR = 'rgba(252, 122, 46, 0.31)';
const EDGE_COLOR = 'rgba(0, 0, 0, 0)';
/** The changes since then: WP green, EP yellow. */
const WP_CHANGE_COLOR = '#2ca02c';
const EP_CHANGE_COLOR = plotTheme.contrastYellow;
const PLOT_HEIGHT = 420;

/**
 * The comparison with the past, by sensor like the measurements' first plot:
 * the bands and the mean of the earlier period, EP and WP of the earlier
 * measurement matching the slider's (its time minus the offset), and the
 * change since then - WP (green) and EP (yellow), now minus then.
 */
const MeasurementComparePlot = ({ rows, pastRows, time, offsetMs, label, loading, onClose }: MeasurementComparePlotProps) => {
  const { t } = useTranslation();
  // The slider's measurement - picked like the measurements chart does.
  const current = React.useMemo(() => {
    const timed = rows
      .flatMap((row) => {
        const ms = parseTimestamp(row.last_fetched);
        return ms == null ? [] : [{ row, ms }];
      })
      .sort((a, b) => a.ms - b.ms);
    if (!timed.length) {
      return null;
    }
    const index = time == null ? timed.length - 1 : frameAt(timed.map((entry) => entry.ms / 1000), time);
    return timed[index].row;
  }, [rows, time]);
  const currentMs = parseTimestamp(current?.last_fetched ?? null);
  const past = React.useMemo(
    () => (currentMs == null ? null : nearestRow(pastRows, currentMs - offsetMs)),
    [pastRows, currentMs, offsetMs],
  );
  const bands = React.useMemo(() => signedBands(pastRows), [pastRows]);

  const data = React.useMemo(() => {
    if (!past) {
      return [];
    }
    const then = potentialsOf(past.samples);
    const now = potentialsOf(current?.samples);
    const sensors = then.ep.map((_, index) => index + 1);
    const line = (name: string, x: number[], y: Array<number | null>, color: string, width: number, dash?: string) => ({
      type: 'scatter' as const,
      mode: 'lines' as const,
      name,
      x,
      y,
      line: { color, width, ...(dash ? { dash } : {}) },
    });
    // A band: the transparent upper edge, then the lower edge filling up to it.
    const band = (name: string, upper: number[], lower: number[], color: string) => [
      { ...line(name, bands.x, upper, EDGE_COLOR, 1), showlegend: false, hoverinfo: 'skip' as const },
      { ...line(name, bands.x, lower, EDGE_COLOR, 1), fill: 'tonexty' as const, fillcolor: color },
    ];
    const change = (nowValues: number[], thenValues: number[]) =>
      thenValues.map((value, index) => (nowValues[index] == null ? null : nowValues[index] - value));
    return [
      ...band(t('measurement_compare_min_max_label'), bands.max, bands.min, MIN_MAX_COLOR),
      ...band(t('measurement_compare_deviation_label'), bands.upper, bands.lower, DEVIATION_COLOR),
      line(t('measurement_compare_mean_label'), bands.x, bands.mean, plotTheme.brandBlue, 4),
      line(t('analyse_compare_ep_then'), sensors, then.ep, 'red', 2, 'dot'),
      line(t('analyse_compare_wp_then'), sensors, then.wp, 'blue', 2, 'dot'),
      ...(now.ep.length
        ? [
            line(t('analyse_compare_wp_change'), sensors, change(now.wp, then.wp), WP_CHANGE_COLOR, 3),
            line(t('analyse_compare_ep_change'), sensors, change(now.ep, then.ep), EP_CHANGE_COLOR, 3),
          ]
        : []),
    ];
  }, [bands, current, past, t]);

  // Ctrl (or ⌘) + wheel zooms, the plain wheel scrolls the page (wheelZoom).
  const [graphDiv, setGraphDiv] = React.useState<HTMLElement | null>(null);
  const [wheelHint, showWheelHint] = useWheelHint();
  usePlotlyWheelZoom(graphDiv, showWheelHint);

  return (
    <Card className="border-0 shadow-sm p-2" data-testid="analyse-compare">
      <Card.Body>
        <div className="d-flex flex-wrap align-items-center gap-3 mb-1">
          <h5 className="mb-0">{t('analyse_compare_title', { label })}</h5>
          {loading && <Spinner size="sm" animation="border" className="text-muted" />}
          <Button
            size="sm"
            variant="outline-secondary"
            className="ms-auto d-inline-flex align-items-center gap-1"
            onClick={onClose}
          >
            <XLg size={12} />
            {t('analyse_compare_end')}
          </Button>
        </div>
        {past && current && (
          <div className="text-muted small mb-2">
            {t('analyse_compare_measurements', {
              now: formatDate(current.last_fetched, 'dateTime'),
              then: formatDate(past.last_fetched, 'dateTime'),
            })}
          </div>
        )}
        {!past ? (
          <div className="text-muted py-4 text-center">
            {loading ? t('ui_loading') : t('analyse_compare_no_data')}
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <WheelZoomHint visible={wheelHint} radius={0} />
            <Plot
              data={data}
              onInitialized={(_, div) => setGraphDiv(div as HTMLElement)}
              useResizeHandler
              style={{ width: '100%', height: `${PLOT_HEIGHT}px` }}
              config={{ responsive: true, displaylogo: false, scrollZoom: true }}
              layout={{
                autosize: true,
                margin: { l: 64, r: 16, t: 56, b: 52 },
                font: { color: plotTheme.brandBlue },
                plot_bgcolor: plotTheme.warmGray1,
                paper_bgcolor: plotTheme.white,
                uirevision: `${offsetMs}:${pastRows.length}`,
                hovermode: 'x unified',
                xaxis: {
                  title: { text: t('measurement_compare_pair_index_axis') },
                  gridcolor: plotTheme.warmGray2,
                  zeroline: false,
                },
                yaxis: {
                  title: { text: t('measurement_compare_absolute_delta_axis') },
                  gridcolor: plotTheme.warmGray2,
                  zeroline: true,
                  zerolinecolor: '#4a4a4a',
                  zerolinewidth: 2,
                },
                legend: {
                  orientation: 'h',
                  x: 0,
                  y: 1.02,
                  yanchor: 'bottom',
                  bgcolor: plotTheme.warmGray1,
                  bordercolor: plotTheme.warmGray3,
                  borderwidth: 1,
                },
              }}
            />
          </div>
        )}
      </Card.Body>
    </Card>
  );
};

export default MeasurementComparePlot;
