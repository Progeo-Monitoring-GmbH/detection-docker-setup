import React from 'react';
import { Button, Card, Spinner } from 'react-bootstrap';
import Plot from 'react-plotly.js';
import { useTranslation } from 'react-i18next';
import { XLg } from 'react-bootstrap-icons';
import { parseTimestamp } from '../../main/alarmUtils';
import { formatDate } from '../../main/dateFormat';
import { plotTheme } from '../../styles/plotTheme';
import {
  usePlotlyTouchScroll,
  usePlotlyWheelZoom,
  useWheelHint,
  WheelZoomHint,
} from '../ui/wheelZoom';
import { frameAt } from './FrameSlider';
import {
  nearestRow,
  potentialsOf,
  sensorChanges,
  wpChangeBands,
} from './measurementBands';
import SensorChangesPanel from './SensorChangesPanel';
import PlotHelp from '../ui/PlotHelp';
import PlotResetButton, { PLOT_CONFIG_NO_MODEBAR } from '../ui/PlotResetButton';

/** No mode bar - only PlotResetButton; Ctrl + wheel zooms (wheelZoom). */
const PLOT_CONFIG = { ...PLOT_CONFIG_NO_MODEBAR, scrollZoom: true };
import type { MeasurementCompareRow } from './MeasurementSamplesCompareChart';
import { childTestId } from '../../testIds';
import './MeasurementComparePlot.css';

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
  /** Sensors (index) of the measurements' second plot - marked in the list. */
  selectedSensors?: number[];
  /** A sensor clicked in the list of changes. */
  onSensorSelect?: (sensor: number) => void;
  /** data-testid of the card; its parts are "<testId>-close", "-plot", "-changes", ... */
  testId?: string;
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
 * the mean, Abweichung and Spannweite of the WP change over the period (each
 * measurement minus the one an offset earlier), EP and WP of the earlier
 * measurement matching the slider's (its time minus the offset), and its
 * change since then - WP (green) and EP (yellow), now minus then.
 */
const MeasurementComparePlot = ({
  rows,
  pastRows,
  time,
  offsetMs,
  label,
  loading,
  onClose,
  selectedSensors,
  onSensorSelect,
  testId = 'analyse-compare',
}: MeasurementComparePlotProps) => {
  const { t } = useTranslation();
  // The sensor hovered in the list of changes - marked in the plot.
  const [hoveredSensor, setHoveredSensor] = React.useState<number | null>(null);
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
    const index =
      time == null
        ? timed.length - 1
        : frameAt(
            timed.map((entry) => entry.ms / 1000),
            time,
          );
    return timed[index].row;
  }, [rows, time]);
  const currentMs = parseTimestamp(current?.last_fetched ?? null);
  const past = React.useMemo(
    () =>
      currentMs == null ? null : nearestRow(pastRows, currentMs - offsetMs),
    [pastRows, currentMs, offsetMs],
  );
  // Mean, Abweichung and Spannweite of the WP change over the period.
  const bands = React.useMemo(() => wpChangeBands(rows, pastRows, offsetMs), [rows, pastRows, offsetMs]);
  const changes = React.useMemo(
    () => (past && current ? sensorChanges(current.samples, past.samples) : []),
    [current, past],
  );

  const data = React.useMemo(() => {
    if (!past) {
      return [];
    }
    const then = potentialsOf(past.samples);
    const now = potentialsOf(current?.samples);
    const sensors = then.ep.map((_, index) => index + 1);
    const line = (
      name: string,
      x: number[],
      y: Array<number | null>,
      color: string,
      width: number,
      dash?: string,
    ) => ({
      type: 'scatter' as const,
      mode: 'lines' as const,
      name,
      x,
      y,
      line: { color, width, ...(dash ? { dash } : {}) },
    });
    // A band: the transparent upper edge, then the lower edge filling up to it.
    const band = (
      name: string,
      upper: number[],
      lower: number[],
      color: string,
    ) => [
      {
        ...line(name, bands.x, upper, EDGE_COLOR, 1),
        showlegend: false,
        hoverinfo: 'skip' as const,
      },
      {
        ...line(name, bands.x, lower, EDGE_COLOR, 1),
        fill: 'tonexty' as const,
        fillcolor: color,
      },
    ];
    const change = (nowValues: number[], thenValues: number[]) =>
      thenValues.map((value, index) =>
        nowValues[index] == null ? null : nowValues[index] - value,
      );
    return [
      ...band(
        t('analyse_compare_change_range'),
        bands.max,
        bands.min,
        MIN_MAX_COLOR,
      ),
      ...band(
        t('analyse_compare_change_deviation'),
        bands.upper,
        bands.lower,
        DEVIATION_COLOR,
      ),
      line(
        t('analyse_compare_change_mean'),
        bands.x,
        bands.mean,
        plotTheme.brandBlue,
        4,
      ),
      line(t('analyse_compare_ep_then'), sensors, then.ep, 'red', 2, 'dot'),
      line(t('analyse_compare_wp_then'), sensors, then.wp, 'blue', 2, 'dot'),
      ...(now.ep.length
        ? [
            line(
              t('analyse_compare_wp_change'),
              sensors,
              change(now.wp, then.wp),
              WP_CHANGE_COLOR,
              3,
            ),
            line(
              t('analyse_compare_ep_change'),
              sensors,
              change(now.ep, then.ep),
              EP_CHANGE_COLOR,
              3,
            ),
          ]
        : []),
    ];
  }, [bands, current, past, t]);

  // Ctrl (or ⌘) + wheel zooms, the plain wheel scrolls the page (wheelZoom).
  const [graphDiv, setGraphDiv] = React.useState<HTMLElement | null>(null);
  const [wheelHint, showWheelHint] = useWheelHint();
  usePlotlyWheelZoom(graphDiv, showWheelHint);
  usePlotlyTouchScroll(graphDiv);

  return (
    <Card className="border-0 shadow-sm p-2" data-testid={testId}>
      <Card.Body>
        <div className="d-flex flex-wrap align-items-center gap-3 mb-1">
          <h5 className="mb-0">{t('analyse_compare_title', { label })}</h5>
          <PlotHelp topic="compare" testId={childTestId(testId, 'help')} />
          <PlotResetButton graphDiv={graphDiv} testId={childTestId(testId, 'reset-scale')} />
          {loading && (
            <Spinner size="sm" animation="border" className="text-muted" data-testid={childTestId(testId, 'loading')} />
          )}
          <Button
            size="sm"
            variant="outline-secondary"
            className="ms-auto d-inline-flex align-items-center gap-1"
            onClick={onClose}
            data-testid={childTestId(testId, 'close')}
          >
            <XLg size={12} />
            {t('analyse_compare_end')}
          </Button>
        </div>
        {past && current && (
          <div className="text-muted small mb-2" data-testid={childTestId(testId, 'measurements')}>
            {t('analyse_compare_measurements', {
              now: formatDate(current.last_fetched, 'dateTime'),
              then: formatDate(past.last_fetched, 'dateTime'),
            })}
          </div>
        )}
        {!past ? (
          <div className="text-muted py-4 text-center" data-testid={childTestId(testId, 'empty')}>
            {loading ? t('ui_loading') : t('analyse_compare_no_data')}
          </div>
        ) : (
          // The plot, and beside it (below on narrow screens) the biggest changes.
          <div className="d-flex flex-wrap gap-3 align-items-start">
            <div className="measurement-compare-plot" data-testid={childTestId(testId, 'plot')}>
              <WheelZoomHint visible={wheelHint} radius={0} testId={childTestId(testId, 'wheel-hint')} />
              <Plot
                data={data}
                onInitialized={(_, div) => setGraphDiv(div as HTMLElement)}
                useResizeHandler
                style={{ width: '100%', height: `${PLOT_HEIGHT}px` }}
                config={PLOT_CONFIG}
                layout={{
                  autosize: true,
                  margin: { l: 64, r: 16, t: 56, b: 52 },
                  font: { color: plotTheme.brandBlue },
                  plot_bgcolor: plotTheme.warmGray1,
                  paper_bgcolor: plotTheme.white,
                  uirevision: `${offsetMs}:${pastRows.length}`,
                  hovermode: 'x unified',
                  shapes:
                    hoveredSensor != null
                      ? [
                          {
                            type: 'rect',
                            layer: 'below',
                            xref: 'x',
                            yref: 'paper',
                            x0: hoveredSensor + 0.5,
                            x1: hoveredSensor + 1.5,
                            y0: 0,
                            y1: 1,
                            fillcolor: plotTheme.brandOrange,
                            opacity: 0.18,
                            line: { width: 0 },
                          },
                        ]
                      : [],
                  xaxis: {
                    gridcolor: plotTheme.warmGray2,
                    zeroline: false,
                  },
                  yaxis: {
                    title: {
                      text: t('measurement_compare_absolute_delta_axis'),
                    },
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
            <div className="measurement-compare-changes">
              <SensorChangesPanel
                changes={changes}
                wpColor={WP_CHANGE_COLOR}
                epColor={EP_CHANGE_COLOR}
                selectedSensors={selectedSensors}
                onSensorSelect={onSensorSelect}
                onSensorHover={setHoveredSensor}
                testId={childTestId(testId, 'changes')}
              />
            </div>
          </div>
        )}
      </Card.Body>
    </Card>
  );
};

export default MeasurementComparePlot;
