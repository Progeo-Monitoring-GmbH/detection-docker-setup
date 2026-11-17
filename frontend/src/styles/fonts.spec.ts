import { describe, expect, it } from 'vitest';
import { canvasFont, FONT_STACK, withPortalFont } from './fonts';

describe('fonts', () => {
  it('leads with Plus Jakarta Sans', () => {
    expect(FONT_STACK.startsWith("'Plus Jakarta Sans'")).toBe(true);
    expect(canvasFont(600, 12)).toBe(`600 12px ${FONT_STACK}`);
  });

  it('gives a Plotly layout the portal font in place, keeping its other font settings', () => {
    const layout: { font?: { family?: string; color?: string } } = {
      font: { color: '#123' },
    };
    expect(withPortalFont(layout)).toBe(layout);
    expect(layout.font).toEqual({ color: '#123', family: FONT_STACK });
  });

  it('keeps a font a chart names itself', () => {
    expect(
      withPortalFont({ font: { family: 'monospace' } })?.font?.family,
    ).toBe('monospace');
  });

  it('adds the font to a layout without one and leaves null alone', () => {
    const bare: { font?: { family?: string } } = {};
    expect(withPortalFont(bare)?.font?.family).toBe(FONT_STACK);
    expect(withPortalFont(null)).toBeNull();
  });
});
