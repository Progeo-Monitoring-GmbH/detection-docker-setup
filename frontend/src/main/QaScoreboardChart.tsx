import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import Plot from 'react-plotly.js';
import Plotly from 'plotly.js/dist/plotly';
import { PLOT_CONFIG_NO_MODEBAR } from '../components/ui/PlotResetButton';
import { usePlotlyTouchScroll } from '../components/ui/wheelZoom';
import { plotTheme } from '../styles/plotTheme';
import { formatDate } from './dateFormat';
import {
  MEAN_COLOR,
  meanRange,
  OTHER_COLOR,
  awardLabel,
  cumulativeLine,
  fixStripLayout,
  fixStripRow,
  formatPoints,
  formatScore,
  pointsOnDay,
  scoreboardStart,
  smoothCurve,
  smoothTotalLine,
  spreadLabels,
  totalAt,
  type QaAward,
  type QaUser,
  type Scoreboard,
} from './qaScoreboardData';

/** Up to this many staff lines are named at their end (the legend names all). */
const DIRECT_LABELS = 6;
/** Height of the line plots without the fix strip (QaScoreboard.css
 * .qa-scoreboard-plot) and their margins - the strip comes on top (fixStripLayout). */
const LINE_HEIGHT = 240;
const LINE_MARGIN = { t: 10, b: 28 };
const LABEL_GAP = 14;

const AXIS = {
  gridcolor: plotTheme.warmGray1,
  linecolor: plotTheme.warmGray2,
  zeroline: false,
};
// The crosshair: a hairline at the hovered time.
const SPIKE = {
  showspikes: true,
  spikemode: 'across' as const,
  spikesnap: 'cursor' as const,
  spikethickness: 1,
  spikedash: 'solid',
  spikecolor: plotTheme.warmGray3,
};
const BASE_LAYOUT = {
  autosize: true,
  font: { color: plotTheme.brandBlue, size: 11 },
  plot_bgcolor: plotTheme.white,
  paper_bgcolor: 'rgba(0,0,0,0)',
  showlegend: false,
  hoverdistance: 30,
};

type HoverEvent = Readonly<{
  points: readonly { curveNumber: number; pointNumber?: number; x?: unknown }[];
}>;

/** The value readout - always in the plot's top left corner, not at the pointer. */
const Readout = ({
  children,
  testId,
}: {
  children: ReactNode;
  testId: string;
}) =>
  children ? (
    <div className="qa-scoreboard-readout" data-testid={testId}>
      {children}
    </div>
  ) : null;

/** A react-plotly plot whose div the highlight restyles (never through the data props). */
const usePlotDiv = () => {
  const [div, setDiv] = useState<HTMLElement | null>(null);
  // One finger scrolls the page over the chart.
  usePlotlyTouchScroll(div);
  return [div, setDiv] as const;
};

const restyle = (
  div: HTMLElement | null,
  update: Record<string, unknown[]>,
) => {
  // A purged div has no _fullLayout - Plotly.restyle on it throws.
  if (!div || !(div as unknown as { _fullLayout?: unknown })._fullLayout) {
    return;
  }
  void Plotly.restyle(div as never, update as never);
};

// ---------------------------------------------------------------------------- mean score

const MeanPlot = ({ board, height }: { board: Scoreboard; height: number }) => {
  const { t } = useTranslation();
  const [, setDiv] = usePlotDiv();
  const [hovered, setHovered] = useState<number | null>(null);

  const figure = useMemo(() => {
    const times = board.mean.map((day) =>
      new Date(`${day.day}T12:00:00`).getTime(),
    );
    const scores = board.mean.map((day) => day.score);
    const curve = smoothCurve(times, scores);
    return {
      data: [
        {
          type: 'scatter' as const,
          mode: 'lines' as const,
          x: curve.x.map((time) => new Date(time).toISOString()),
          y: curve.y,
          line: { color: MEAN_COLOR, width: 2 },
          hoverinfo: 'skip' as const,
        },
        // The days themselves: markers (few days) and the hover targets.
        {
          type: 'scatter' as const,
          mode: 'markers' as const,
          x: times.map((time) => new Date(time).toISOString()),
          y: scores,
          marker: {
            color: MEAN_COLOR,
            size: board.mean.length > 40 ? 0 : 7,
            line: { color: plotTheme.white, width: 2 },
          },
          hoverinfo: 'none' as const,
        },
      ],
      layout: {
        ...BASE_LAYOUT,
        margin: { l: 8, r: 12, ...LINE_MARGIN },
        hovermode: 'x' as const,
        xaxis: { ...AXIS, ...SPIKE, type: 'date' as const, automargin: true },
        yaxis: { ...AXIS, range: meanRange(scores), automargin: true },
      },
    };
  }, [board]);

  const day = hovered != null ? board.mean[hovered] : null;
  return (
    <div className="qa-scoreboard-plot-cell">
      <div className="qa-scoreboard-plot-title">{t('qa_mean_line')}</div>
      <div className="qa-scoreboard-plot-wrap">
        <Plot
          className="qa-scoreboard-plot"
          // As high as the points plot beside it (with its fix strip).
          style={{ height }}
          data={figure.data}
          layout={figure.layout}
          config={PLOT_CONFIG_NO_MODEBAR}
          useResizeHandler
          onInitialized={(_figure, graph) => setDiv(graph)}
          onPurge={() => setDiv(null)}
          onHover={(event: HoverEvent) => {
            const point = event.points.find((entry) => entry.curveNumber === 1);
            setHovered(point?.pointNumber ?? null);
          }}
          onUnhover={() => setHovered(null)}
        />
        <Readout testId="qa-mean-readout">
          {day && (
            <>
              <div>
                <strong>{formatScore(day.score)}</strong> / 100
              </div>
              <div className="qa-scoreboard-readout-muted">
                {formatDate(`${day.day}T12:00:00`, 'date')} ·{' '}
                {t('qa_mean_locations', { count: day.locations })}
              </div>
            </>
          )}
        </Readout>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------- staff points

type PointsHover = { userId: number; time: number; award: QaAward | null };

const PointsPlot = ({
  board,
  scorers,
  strip,
  colors,
  active,
  onActive,
}: {
  board: Scoreboard;
  scorers: QaUser[];
  strip: ReturnType<typeof fixStripLayout>;
  colors: Map<number, string>;
  active: number | null;
  onActive: (userId: number | null) => void;
}) => {
  const { t } = useTranslation();
  const [div, setDiv] = usePlotDiv();
  const [hovered, setHovered] = useState<PointsHover | null>(null);

  const figure = useMemo(() => {
    const start = scoreboardStart(board);
    const yMax = Math.max(1, ...scorers.map((user) => user.total)) * 1.1;
    // Each staff member: the smooth line and the fixes as ticks in their
    // row of the strip below (marks on the lines covered them) -
    // owners[i] is trace i's user.
    const owners: number[] = [];
    // The fixes of each trace in marker order (null: a line).
    const traceAwards: (QaAward[] | null)[] = [];
    const data = scorers.flatMap((user, index) => {
      const color = colors.get(user.id) ?? OTHER_COLOR;
      const curve = smoothTotalLine(user.awards, start, board.now);
      const fixes = cumulativeLine(user.awards, start, board.now);
      const inner = fixes.awards
        .map((award, index) => ({ award, index }))
        .filter(({ award }) => award);
      owners.push(user.id, user.id);
      traceAwards.push(
        null,
        inner.map(({ award }) => award as QaAward),
      );
      return [
        {
          type: 'scatter' as const,
          mode: 'lines' as const,
          x: curve.x.map((time) => new Date(time).toISOString()),
          y: curve.y,
          line: { color, width: 2 },
          hoverinfo: 'none' as const,
        },
        {
          type: 'scatter' as const,
          mode: 'markers' as const,
          x: inner.map(({ index: fix }) => fixes.x[fix]),
          y: inner.map(() => fixStripRow(index, scorers.length)),
          yaxis: 'y2' as const,
          marker: {
            symbol: 'line-ns' as const,
            color,
            size: 11,
            line: { color, width: 2 },
          },
          hoverinfo: 'none' as const,
        },
      ];
    });

    // Names at the line ends, moved apart where they would overlap
    // (a thin leader line points to the end they belong to).
    const named = [...scorers]
      .sort((a, b) => b.total - a.total)
      .slice(0, DIRECT_LABELS);
    const plotPx = LINE_HEIGHT - LINE_MARGIN.t - LINE_MARGIN.b;
    const ends = named.map((user) => (user.total / yMax) * plotPx);
    const spread = spreadLabels(ends, LABEL_GAP, 6, plotPx - 6);
    const annotations = named.map((user, index) => ({
      x: board.now,
      y: user.total,
      xref: 'x' as const,
      yref: 'y' as const,
      text: user.username,
      showarrow: true,
      arrowhead: 0,
      arrowwidth: 1,
      arrowcolor: plotTheme.warmGray4,
      standoff: 3,
      ax: 14,
      ay: -(spread[index] - ends[index]),
      xanchor: 'left' as const,
      font: { color: plotTheme.brandBlue, size: 11 },
    }));
    const longest = Math.max(0, ...named.map((user) => user.username.length));

    return {
      owners,
      traceAwards,
      data,
      layout: {
        ...BASE_LAYOUT,
        margin: { l: 8, r: Math.min(150, 24 + longest * 6.5), ...LINE_MARGIN },
        hovermode: 'closest' as const,
        annotations: [
          ...annotations,
          {
            text: t('qa_column_fixes'),
            xref: 'paper' as const,
            yref: 'paper' as const,
            x: 0,
            y: strip.title,
            xanchor: 'left' as const,
            yanchor: 'middle' as const,
            showarrow: false,
            font: { color: plotTheme.warmGray4, size: 10.5 },
          },
        ],
        // The lines' baseline - the time axis sits under the strip.
        shapes: [
          {
            type: 'line' as const,
            xref: 'paper' as const,
            yref: 'paper' as const,
            x0: 0,
            x1: 1,
            y0: strip.lines[0],
            y1: strip.lines[0],
            line: { color: plotTheme.warmGray2, width: 1 },
          },
        ],
        xaxis: {
          ...AXIS,
          ...SPIKE,
          type: 'date' as const,
          range: [start, board.now],
          anchor: 'y2' as const,
          automargin: true,
        },
        yaxis: {
          ...AXIS,
          range: [0, yMax],
          domain: strip.lines,
          automargin: true,
        },
        yaxis2: {
          domain: strip.strip,
          range: [-0.7, Math.max(scorers.length, 1) - 0.3],
          showgrid: false,
          zeroline: false,
          showticklabels: false,
          fixedrange: true,
        },
      },
    };
  }, [board, colors, scorers, strip, t]);

  // The hovered staff member stands out, the others step back.
  useEffect(() => {
    restyle(div, {
      opacity: figure.owners.map((owner) =>
        active == null || owner === active ? 1 : 0.18,
      ),
      'line.width': figure.owners.map((owner) => (owner === active ? 3 : 2)),
    });
  }, [active, div, figure]);

  const onHover = useCallback(
    (event: HoverEvent) => {
      const point = event.points[0];
      const userId = point ? figure.owners[point.curveNumber] : undefined;
      if (userId == null || point.x == null) {
        return;
      }
      // On a fix marker: that fix.
      const award =
        point.pointNumber != null
          ? (figure.traceAwards[point.curveNumber]?.[point.pointNumber] ?? null)
          : null;
      setHovered({ userId, time: new Date(String(point.x)).getTime(), award });
      onActive(userId);
    },
    [figure, onActive],
  );

  // One readout, every staff member at that time - the hovered one first.
  const rows = hovered
    ? scorers
        .map((user) => ({ user, total: totalAt(user.awards, hovered.time) }))
        .sort((a, b) =>
          a.user.id === hovered.userId
            ? -1
            : b.user.id === hovered.userId
              ? 1
              : b.total - a.total,
        )
        .slice(0, 5)
    : [];

  return (
    <div className="qa-scoreboard-plot-cell">
      <div className="qa-scoreboard-plot-title">{t('qa_points_title')}</div>
      <div className="qa-scoreboard-plot-wrap">
        <Plot
          className="qa-scoreboard-plot"
          style={{ height: strip.height }}
          data={figure.data}
          layout={figure.layout}
          config={PLOT_CONFIG_NO_MODEBAR}
          useResizeHandler
          onInitialized={(_figure, graph) => setDiv(graph)}
          // Must not restyle here: react-plotly fires onUpdate on every restyle.
          onUpdate={(_figure, graph) => setDiv(graph)}
          onPurge={() => setDiv(null)}
          onHover={onHover}
          onUnhover={() => {
            setHovered(null);
            onActive(null);
          }}
        />
        <Readout testId="qa-points-readout">
          {hovered && (
            <>
              <div className="qa-scoreboard-readout-muted">
                {formatDate(new Date(hovered.time).toISOString())}
              </div>
              {hovered.award && (
                <div className="qa-scoreboard-readout-muted">
                  <strong>+{formatPoints(hovered.award.points)}</strong> ·{' '}
                  {awardLabel(t, hovered.award)}
                </div>
              )}
              {rows.map(({ user, total }) => (
                <div
                  key={user.id}
                  className={
                    user.id === hovered.userId
                      ? 'qa-scoreboard-readout-row is-active'
                      : 'qa-scoreboard-readout-row'
                  }
                >
                  <span
                    className="qa-scoreboard-swatch"
                    style={{
                      backgroundColor: colors.get(user.id) ?? OTHER_COLOR,
                    }}
                    aria-hidden="true"
                  />
                  <strong>{formatPoints(total)}</strong>
                  <span className="qa-scoreboard-readout-muted">
                    {user.username}
                  </span>
                </div>
              ))}
            </>
          )}
        </Readout>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------- pies

const PointsPie = ({
  title,
  scorers,
  values,
  colors,
  active,
  onActive,
  empty,
  testId,
}: {
  title: string;
  scorers: QaUser[];
  values: number[];
  colors: Map<number, string>;
  active: number | null;
  onActive: (userId: number | null) => void;
  empty: string;
  testId: string;
}) => {
  const { t } = useTranslation();
  const [div, setDiv] = usePlotDiv();
  const slices = useMemo(
    () =>
      scorers
        .map((user, index) => ({ user, value: values[index] }))
        .filter((slice) => slice.value > 0),
    [scorers, values],
  );
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  const figure = useMemo(
    () => ({
      data: [
        {
          type: 'pie' as const,
          labels: slices.map((slice) => slice.user.username),
          values: slices.map((slice) => slice.value),
          sort: false,
          direction: 'clockwise' as const,
          hole: 0.58,
          marker: {
            colors: slices.map(
              (slice) => colors.get(slice.user.id) ?? OTHER_COLOR,
            ),
            line: { color: plotTheme.white, width: 2 },
          },
          textinfo: 'none' as const,
          hovertemplate: `<b>%{value}</b> ${t('qa_axis_points')} · %{percent}<br>%{label}<extra></extra>`,
        },
      ],
      layout: {
        ...BASE_LAYOUT,
        margin: { l: 4, r: 4, t: 4, b: 4 },
        annotations: [
          {
            text: `<b>${formatPoints(total)}</b>`,
            showarrow: false,
            font: { size: 18, color: plotTheme.brandBlue },
          },
        ],
      },
    }),
    [colors, slices, t, total],
  );

  useEffect(() => {
    restyle(div, {
      pull: [slices.map((slice) => (slice.user.id === active ? 0.06 : 0))],
    });
  }, [active, div, slices]);

  return (
    <div className="qa-scoreboard-pie-cell" data-testid={testId}>
      <div className="qa-scoreboard-plot-title">{title}</div>
      {slices.length === 0 ? (
        <div className="qa-scoreboard-pie-empty">{empty}</div>
      ) : (
        <Plot
          className="qa-scoreboard-pie"
          data={figure.data}
          layout={figure.layout}
          config={PLOT_CONFIG_NO_MODEBAR}
          useResizeHandler
          onInitialized={(_figure, graph) => setDiv(graph)}
          onUpdate={(_figure, graph) => setDiv(graph)}
          onPurge={() => setDiv(null)}
          onHover={(event: HoverEvent) => {
            const index = event.points[0]?.pointNumber;
            onActive(index != null ? (slices[index]?.user.id ?? null) : null);
          }}
          onUnhover={() => onActive(null)}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------- the chart

/**
 * The scoreboard's charts (QaScoreboard - loaded with it on demand, Plotly
 * is big): the mean score of all locations and each staff member's running
 * points side by side, the shared legend, and the points of today and of
 * all time as donuts. Hovering a line, a legend entry or a slice
 * highlights that staff member everywhere.
 */
const QaScoreboardChart = ({
  board,
  colors,
}: {
  board: Scoreboard;
  colors: Map<number, string>;
}) => {
  const { t } = useTranslation();
  // The highlighted staff member (React skips the render when it stays the same).
  const [active, onActive] = useState<number | null>(null);

  const scorers = useMemo(
    () => board.users.filter((user) => user.count > 0),
    [board],
  );
  const today = useMemo(
    () => scorers.map((user) => pointsOnDay(user, board.now)),
    [board, scorers],
  );
  const overall = useMemo(() => scorers.map((user) => user.total), [scorers]);
  // The points plot's fix strip - the mean plot beside it as high.
  const strip = useMemo(
    () => fixStripLayout(scorers.length, LINE_HEIGHT, LINE_MARGIN),
    [scorers.length],
  );

  return (
    <div className="qa-scoreboard-charts" data-testid="qa-scoreboard-charts">
      <div className="qa-scoreboard-row">
        <MeanPlot board={board} height={strip.height} />
        <PointsPlot
          board={board}
          scorers={scorers}
          strip={strip}
          colors={colors}
          active={active}
          onActive={onActive}
        />
      </div>
      {scorers.length > 0 && (
        <>
          <div
            className="qa-scoreboard-legend"
            data-testid="qa-scoreboard-legend"
          >
            {scorers.map((user) => (
              <button
                key={user.id}
                type="button"
                className={
                  active === user.id
                    ? 'qa-scoreboard-legend-item is-active'
                    : active != null
                      ? 'qa-scoreboard-legend-item is-dimmed'
                      : 'qa-scoreboard-legend-item'
                }
                onMouseEnter={() => onActive(user.id)}
                onMouseLeave={() => onActive(null)}
                onFocus={() => onActive(user.id)}
                onBlur={() => onActive(null)}
              >
                <span
                  className="qa-scoreboard-swatch"
                  style={{
                    backgroundColor: colors.get(user.id) ?? OTHER_COLOR,
                  }}
                  aria-hidden="true"
                />
                {user.username}
                <span className="qa-scoreboard-legend-value">
                  {formatPoints(user.total)}
                </span>
              </button>
            ))}
          </div>
          <div className="qa-scoreboard-row qa-scoreboard-row--pies">
            <PointsPie
              title={t('qa_pie_today')}
              scorers={scorers}
              values={today}
              colors={colors}
              active={active}
              onActive={onActive}
              empty={t('qa_pie_today_empty')}
              testId="qa-pie-today"
            />
            <PointsPie
              title={t('qa_pie_overall')}
              scorers={scorers}
              values={overall}
              colors={colors}
              active={active}
              onActive={onActive}
              empty={t('qa_scoreboard_empty')}
              testId="qa-pie-overall"
            />
          </div>
        </>
      )}
    </div>
  );
};

export default QaScoreboardChart;
