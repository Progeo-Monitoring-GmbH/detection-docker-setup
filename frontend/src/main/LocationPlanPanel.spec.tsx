// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import type { PlanVisualization } from './projectType';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const translation = vi.hoisted(() => ({ t: (key: string) => key, i18n: { language: 'de' } }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => translation,
}));
// The plan views draw on canvas / SVG with layout - stand-ins here.
vi.mock('../components/device/SensorHeatmap2D', () => ({ default: () => <div data-testid="stub-heatmap" /> }));
vi.mock('../components/device/LageplanZoneOverlay', () => ({ default: () => <div data-testid="stub-overlay" /> }));

const { default: LocationPlanPanel } = await import('./LocationPlanPanel');

const PLAN = { id: 5, url: '/media/plan.png', is_active: true, name: 'EG' };

/** Two sensors: 1 above the object's 100, 2 disabled (and above as well). */
const heatmapOf = (withPlan: boolean): SensorHeatmapResponse =>
  ({
    timestamps: [100, 200],
    data: { '1': [50, 180], '2': [900, 900] },
    sensor_points: [
      { pos: 1, x: 0.2, y: 0.2, name: 'Bad' },
      { pos: 2, x: 0.6, y: 0.2, name: 'Küche', disabled: true },
      { pos: 2, x: 0.7, y: 0.3, name: 'Küche', disabled: true }, // a second point of sensor 2
    ],
    location: { lageplans: withPlan ? [PLAN] : [] },
  }) as unknown as SensorHeatmapResponse;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (visualization: PlanVisualization, heatmap: SensorHeatmapResponse | null, denied = false) =>
  act(() => {
    root.render(
      <LocationPlanPanel
        heatmap={heatmap}
        visualization={visualization}
        withSensorTable={false}
        threshold={100}
        denied={denied}
        alarmSpans={[]}
      />,
    );
  });

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const states = () =>
  [...container.querySelectorAll('[data-testid="plan-panel-tiles-tile"]')].map((tile) => [
    tile.textContent?.split('sensor_tile_')[0],
    tile.getAttribute('data-state'),
  ]);

describe('LocationPlanPanel - Sensoransicht', () => {
  it('shows smartex® is as one tile per sensor - even with a Lageplan', () => {
    render('tiles', heatmapOf(true));

    expect(container.textContent).toContain('status_sensoransicht_title');
    expect(byTestId('stub-overlay')).toBeNull();
    // Each sensor once, with its newest reading: 180 > 100 is an alarm; 2 is off.
    expect(states()).toEqual([
      ['Bad', 'alarm'],
      ['Küche', 'disabled'],
    ]);
  });

  it('shows the tiles for every product while there is no Lageplan', () => {
    render('segments', heatmapOf(false));

    expect(container.textContent).toContain('status_sensoransicht_title');
    expect(byTestId('plan-panel-tiles')).not.toBeNull();
    expect(byTestId('plan-panel-no-plan')).toBeNull();
  });

  it('keeps the Dachansicht with its plan for the other products', () => {
    render('segments', heatmapOf(true));

    expect(container.textContent).toContain('status_dachansicht_title');
    expect(byTestId('stub-overlay')).not.toBeNull();
    expect(byTestId('plan-panel-tiles')).toBeNull();
  });

  it('shows no tiles without access to the measurements', () => {
    render('tiles', heatmapOf(true), true);

    expect(byTestId('plan-panel-denied')).not.toBeNull();
    expect(byTestId('plan-panel-tiles')).toBeNull();
  });
});
