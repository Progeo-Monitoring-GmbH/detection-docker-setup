import { describe, expect, it, vi } from 'vitest';

vi.mock('plotly.js/dist/plotly', () => ({ default: { relayout: vi.fn() } }));

const { resetScaleUpdate } = await import('./PlotResetButton');

describe('resetScaleUpdate', () => {
  it('puts every axis back to its initial range - autorange where it had none', () => {
    expect(
      resetScaleUpdate({
        xaxis: { _name: 'xaxis' },
        yaxis: { _name: 'yaxis', _rangeInitial0: -5, _rangeInitial1: 120 },
        xaxis2: { _name: 'xaxis2', _rangeInitial1: 10, _autorangeInitial: 'min' },
        yaxis3: { _name: 'yaxis3', fixedrange: true },
        legend: { _name: 'legend' },
        width: 800,
      }),
    ).toEqual({
      'xaxis.autorange': true,
      'yaxis.range': [-5, 120],
      'xaxis2.range': [null, 10],
      'xaxis2.autorange': 'min',
    });
  });
});
