import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Plot from 'react-plotly.js';
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
  formatPoints,
  scoreboardStart,
  type Scoreboard,
} from './qaScoreboardData';

/** Up to this many staff lines are also labelled at their end (the legend names all). */
const DIRECT_LABELS = 4;

/**
 * The scoreboard's chart (QaScoreboard - loaded with it on demand, Plotly
 * is big): the mean score of all locations above, each staff member's
 * running points below, on one time axis.
 */
const QaScoreboardChart = ({
  board,
  colors,
}: {
  board: Scoreboard;
  colors: Map<number, string>;
}) => {
  const { t } = useTranslation();
  const [graphDiv, setGraphDiv] = useState<HTMLElement | null>(null);
  // One finger scrolls the page over the chart.
  usePlotlyTouchScroll(graphDiv);

  const plot = useMemo(() => {
    const start = scoreboardStart(board);
    const scorers = board.users.filter((user) => user.count > 0);
    const labelled = scorers.length <= DIRECT_LABELS;
    const mean = {
      type: 'scatter' as const,
      mode:
        board.mean.length > 40
          ? ('lines' as const)
          : ('lines+markers' as const),
      name: t('qa_mean_line'),
      x: board.mean.map((day) => day.day),
      y: board.mean.map((day) => day.score),
      customdata: board.mean.map(
        (day) =>
          `${formatDate(`${day.day}T12:00:00`, 'date')} · ${t('qa_mean_locations', { count: day.locations })}`,
      ),
      hovertemplate: `%{customdata}<br><b>%{y:.1f}</b> / 100<extra></extra>`,
      line: { color: MEAN_COLOR, width: 2 },
      marker: { color: MEAN_COLOR, size: 8 },
      xaxis: 'x',
      yaxis: 'y',
      showlegend: false,
    };
    const users = scorers.map((user) => {
      const line = cumulativeLine(user.awards, start, board.now);
      const last = line.x.length - 1;
      return {
        type: 'scatter' as const,
        mode: labelled
          ? ('lines+markers+text' as const)
          : ('lines+markers' as const),
        name: user.username,
        x: line.x,
        y: line.y,
        // Markers on the fixes only - not on the line's start and end.
        marker: {
          color: colors.get(user.id) ?? OTHER_COLOR,
          size: line.awards.map((award) => (award ? 8 : 0)),
          line: { color: plotTheme.white, width: 2 },
        },
        line: {
          color: colors.get(user.id) ?? OTHER_COLOR,
          width: 2,
          shape: 'hv' as const,
        },
        text: line.x.map((_x, index) =>
          labelled && index === last ? user.username : '',
        ),
        textposition: 'top left' as const,
        textfont: { color: plotTheme.brandBlue, size: 12 },
        customdata: line.awards.map((award) =>
          award
            ? `+${formatPoints(award.points)} · ${awardLabel(t, award)}<br>${formatDate(award.at)}`
            : t('qa_total'),
        ),
        hovertemplate: `<b>${user.username}</b>: %{y:.1f}<br>%{customdata}<extra></extra>`,
        xaxis: 'x',
        yaxis: 'y2',
      };
    });
    return { data: [mean, ...users], start };
  }, [board, colors, t]);

  return (
    <Plot
      className="qa-scoreboard-plot"
      data={plot.data}
      onInitialized={(_figure, div) => setGraphDiv(div)}
      onPurge={() => setGraphDiv(null)}
      useResizeHandler
      config={PLOT_CONFIG_NO_MODEBAR}
      layout={{
        autosize: true,
        margin: { l: 8, r: 16, t: 28, b: 8 },
        font: { color: plotTheme.brandBlue, size: 12 },
        plot_bgcolor: plotTheme.white,
        paper_bgcolor: 'rgba(0,0,0,0)',
        hovermode: 'closest',
        showlegend: plot.data.length > 1,
        legend: { orientation: 'h', x: 0, y: -0.12, yanchor: 'top' },
        xaxis: {
          type: 'date',
          anchor: 'y2',
          range: [plot.start, board.now],
          gridcolor: plotTheme.warmGray1,
          linecolor: plotTheme.warmGray2,
          automargin: true,
        },
        // Two panels on one time axis - the mean score and the points
        // have their own scales, never two scales on one panel.
        yaxis: {
          domain: [0.6, 1],
          range: meanRange(board.mean.map((day) => day.score)),
          title: { text: t('qa_axis_mean') },
          gridcolor: plotTheme.warmGray1,
          zeroline: false,
          automargin: true,
        },
        yaxis2: {
          domain: [0, 0.5],
          rangemode: 'tozero',
          title: { text: t('qa_axis_points') },
          gridcolor: plotTheme.warmGray1,
          zeroline: false,
          automargin: true,
        },
      }}
    />
  );
};

export default QaScoreboardChart;
