/**
 * The portal's one font: Plus Jakarta Sans, bundled locally
 * (src/assets/fonts/plus-jakarta-sans, a variable font for weights 200-800).
 * CSS gets it from Bootstrap's $font-family-sans-serif (scss/style.scss);
 * this stack is for what does not inherit CSS - Plotly layouts
 * (src/plotly.ts) and canvas text. Keep the two in sync.
 */
export const FONT_STACK = "'Plus Jakarta Sans', 'Segoe UI', Tahoma, sans-serif";

/** A canvas `ctx.font` value in the portal font, e.g. canvasFont(600, 12). */
export const canvasFont = (weight: number, sizePx: number) =>
  `${weight} ${sizePx}px ${FONT_STACK}`;

export type PlotLayoutFont = { font?: { family?: string } } | null | undefined;

/**
 * Plotly draws its text in SVG with its own default font ("Open Sans") and
 * ignores the page's CSS. Every chart gets the portal font unless its
 * layout names one: legends, ticks, titles and hover labels inherit
 * layout.font.family. The layout is completed in place, the way Plotly
 * itself writes back into it, so its identity stays (react-plotly).
 */
export const withPortalFont = <T extends PlotLayoutFont>(layout: T): T => {
  if (layout && typeof layout === 'object') {
    layout.font = { ...layout.font, family: layout.font?.family ?? FONT_STACK };
  }
  return layout;
};
