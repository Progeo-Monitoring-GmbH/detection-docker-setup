import { useTranslation } from 'react-i18next';
import { childTestId, repeatedTestId } from '../../testIds';
import type { SensorListRow } from './SensorListTable';
import './SensorStatusTiles.css';

/** The state a tile shows: below (ok) or above (alarm) its threshold, switched off, or no reading. */
export type SensorTileState = 'ok' | 'alarm' | 'disabled' | 'nodata';

/**
 * A sensor's state: disabled first (it never alarms), then no reading,
 * then above its threshold (alarm) - else ok, also without a threshold.
 */
export const sensorTileState = (row: SensorListRow): SensorTileState => {
  if (row.disabled) {
    return 'disabled';
  }
  if (row.value == null) {
    return 'nodata';
  }
  return row.threshold != null && row.value > row.threshold ? 'alarm' : 'ok';
};

const formatMv = (value: number | null) => (value != null ? String(Math.round(value)) : '–');

type SensorStatusTilesProps = {
  /** One tile per row, in the given order (sensorRowsOf: sensor order). */
  rows: SensorListRow[];
  /** data-testid of the grid; each tile is "<testId>-tile" (key: the row key, data-state: its state). */
  testId?: string;
};

/**
 * "Sensoransicht": every sensor as a tile with its name and a large status
 * block - green below its threshold, red above it, gray when disabled or
 * without a reading - and the value against the threshold underneath. For
 * products without a plan view (smartex® is) and locations without a
 * Lageplan; usable anywhere a list of SensorListRow is at hand.
 */
const SensorStatusTiles = ({ rows, testId = 'sensor-tiles' }: SensorStatusTilesProps) => {
  const { t } = useTranslation();

  if (rows.length === 0) {
    return (
      <div className="sensor-tiles-empty" data-testid={childTestId(testId, 'empty')}>
        {t('status_sensor_table_empty')}
      </div>
    );
  }

  return (
    <div className="sensor-tiles" data-testid={testId}>
      {rows.map((row) => {
        const state = sensorTileState(row);
        return (
          <div
            key={row.key}
            className={`sensor-tile sensor-tile--${state}`}
            data-state={state}
            {...repeatedTestId(`${testId}-tile`, row.key)}
          >
            <div className="sensor-tile-name" title={row.label}>
              {row.label}
            </div>
            <div className="sensor-tile-status">{t(`sensor_tile_${state}`)}</div>
            <div className="sensor-tile-reading">
              {state === 'disabled'
                ? t('status_sensor_table_disabled_hint')
                : row.threshold != null
                  ? t('sensor_tile_reading', { value: formatMv(row.value), threshold: formatMv(row.threshold) })
                  : t('sensor_tile_reading_no_threshold', { value: formatMv(row.value) })}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default SensorStatusTiles;
