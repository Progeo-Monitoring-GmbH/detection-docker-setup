// Custom Plotly bundle with only the trace types this app renders.
// vite.config.ts aliases 'plotly.js/dist/plotly' (used by react-plotly.js) to
// this file, so the full ~4.8 MB bundle never ends up in the build.
// When a chart needs a new trace type, register it here.
import Plotly from 'plotly.js/lib/core';
import bar from 'plotly.js/lib/bar';
import heatmap from 'plotly.js/lib/heatmap';
// The scoreboard's donuts (QaScoreboardChart).
import pie from 'plotly.js/lib/pie';
import scatter from 'plotly.js/lib/scatter';
import scattergl from 'plotly.js/lib/scattergl';
import { type PlotLayoutFont, withPortalFont } from './styles/fonts';

Plotly.register([bar, heatmap, pie, scatter, scattergl]);

type PlotFn = (
  el: unknown,
  dataOrFigure?: unknown,
  layout?: unknown,
  ...rest: unknown[]
) => unknown;

const fontWrapped = (plot: PlotFn): PlotFn =>
  function (el, dataOrFigure, layout, ...rest) {
    // react-plotly passes one figure object ({ data, layout, config });
    // direct callers pass (el, data, layout, config).
    // Without data (a bare redraw call) nothing is touched: a new layout
    // there would replace the chart's current one.
    if (Array.isArray(dataOrFigure)) {
      layout = withPortalFont((layout as PlotLayoutFont) ?? {});
    } else if (dataOrFigure && typeof dataOrFigure === 'object') {
      const figure = dataOrFigure as { layout?: PlotLayoutFont };
      figure.layout = withPortalFont(figure.layout ?? {});
    }
    return plot(el, dataOrFigure, layout, ...rest);
  };

const plotly = Plotly as unknown as Record<'react' | 'newPlot', PlotFn>;
plotly.react = fontWrapped(plotly.react.bind(Plotly));
plotly.newPlot = fontWrapped(plotly.newPlot.bind(Plotly));

export default Plotly;
