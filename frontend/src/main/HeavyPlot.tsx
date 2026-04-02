// HeavyPlot.tsx
import React from 'react';
import Plot from 'react-plotly.js';

export const HeavyPlot: React.FC = ({ data, layout, style, config }) => {
  return <Plot data={data} layout={layout} style={style} config={config} />;
};
