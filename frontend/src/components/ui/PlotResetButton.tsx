import { Button } from 'react-bootstrap';
import { ArrowCounterclockwise } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import Plotly from 'plotly.js/dist/plotly';
import './PlotResetButton.css';

/** What the reset reads of Plotly's full (internal) axes. */
type ResetAxis = {
  _name?: string;
  fixedrange?: boolean;
  _rangeInitial0?: unknown;
  _rangeInitial1?: unknown;
  _autorangeInitial?: unknown;
};

/**
 * The relayout of Plotly's own "Reset axes" (modebar resetScale2d): every
 * axis back to its initial range - autorange where it had none. Mirrors
 * handleCartesian in plotly.js/src/components/modebar/buttons.js; the mode
 * bar itself is hidden on our plots.
 */
export const resetScaleUpdate = (fullLayout: Record<string, unknown>) => {
  const update: Record<string, unknown> = {};
  Object.entries(fullLayout).forEach(([key, value]) => {
    if (!/^[xy]axis\d*$/.test(key) || !value || typeof value !== 'object') {
      return;
    }
    const axis = value as ResetAxis;
    if (axis.fixedrange) {
      return;
    }
    const name = axis._name ?? key;
    const from = axis._rangeInitial0;
    const to = axis._rangeInitial1;
    if (from === undefined && to === undefined) {
      update[`${name}.autorange`] = true;
    } else if (from === undefined || to === undefined) {
      update[`${name}.range`] = [from ?? null, to ?? null];
      update[`${name}.autorange`] = axis._autorangeInitial;
    } else {
      update[`${name}.range`] = [from, to];
    }
  });
  return update;
};

/** Plot config without the mode bar - zoom (drag a box, Ctrl + wheel) and
 * pan (drag an axis) still work; PlotResetButton undoes them. */
export const PLOT_CONFIG_NO_MODEBAR = { responsive: true, displaylogo: false, displayModeBar: false } as const;

type PlotResetButtonProps = {
  /** The Plotly graph div (onInitialized) - null until it is drawn. */
  graphDiv: HTMLElement | null;
  className?: string;
  /** data-testid of the button - set it when a page shows several plots. */
  testId?: string;
};

/** "Reset scale": the one plot control left - a visible button instead of
 * a mode bar icon that only shows on hover. */
const PlotResetButton = ({ graphDiv, className, testId = 'plot-reset-scale' }: PlotResetButtonProps) => {
  const { t } = useTranslation();
  const reset = () => {
    const fullLayout = (graphDiv as { _fullLayout?: Record<string, unknown> } | null)?._fullLayout;
    if (graphDiv && fullLayout) {
      void Plotly.relayout(graphDiv as never, resetScaleUpdate(fullLayout) as never);
    }
  };
  return (
    <Button
      size="sm"
      variant="outline-primary"
      className={`d-inline-flex align-items-center gap-1 py-0 plot-reset-button ${className ?? ''}`}
      onClick={reset}
      disabled={!graphDiv}
      title={t('plot_reset_scale_hint')}
      data-testid={testId}
    >
      <ArrowCounterclockwise size={13} />
      {t('plot_reset_scale')}
    </Button>
  );
};

export default PlotResetButton;
