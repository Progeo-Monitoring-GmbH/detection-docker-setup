// Custom Plotly bundle with only the trace types this app renders.
// vite.config.ts aliases 'plotly.js/dist/plotly' (used by react-plotly.js) to
// this file, so the full ~4.8 MB bundle never ends up in the build.
// When a chart needs a new trace type, register it here.
import Plotly from 'plotly.js/lib/core';
import bar from 'plotly.js/lib/bar';
import heatmap from 'plotly.js/lib/heatmap';
import scatter from 'plotly.js/lib/scatter';
import scattergl from 'plotly.js/lib/scattergl';

Plotly.register([bar, heatmap, scatter, scattergl]);

export default Plotly;
