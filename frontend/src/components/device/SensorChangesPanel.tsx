import { useState } from 'react';
import { Button } from 'react-bootstrap';
import { CheckLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import type { SensorChange } from './measurementBands';

/** How many changes show at first, and how many more each click shows. */
export const CHANGES_PAGE = 10;

type SensorChangesPanelProps = {
  /** Biggest first (sensorChanges). */
  changes: SensorChange[];
  /** Colours of the change lines in the plot. */
  wpColor: string;
  epColor: string;
  /** Sensors (index) shown in the measurements' second plot - marked. */
  selectedSensors?: number[];
  /** A click on a sensor: show it in (or remove it from) the second plot. */
  onSensorSelect?: (sensor: number) => void;
  /** The hovered sensor (null when left) - marked in the plot. */
  onSensorHover?: (sensor: number | null) => void;
};

const formatChange = (value: number) =>
  `${value > 0 ? '+' : ''}${value.toFixed(2)}`;

const Swatch = ({ color }: { color: string }) => (
  <span
    aria-hidden="true"
    style={{
      display: 'inline-block',
      width: 10,
      height: 3,
      borderRadius: 2,
      background: color,
      marginRight: 4,
      verticalAlign: 'middle',
    }}
  />
);

/**
 * The comparison's biggest changes: per sensor the change of WP and EP since
 * then, CHANGES_PAGE at a time ("show more"). A click shows the sensor in the
 * measurements' second plot.
 */
const SensorChangesPanel = ({
  changes,
  wpColor,
  epColor,
  selectedSensors = [],
  onSensorSelect,
  onSensorHover,
}: SensorChangesPanelProps) => {
  const { t } = useTranslation();
  const [shownCount, setShownCount] = useState(CHANGES_PAGE);
  const shown = changes.slice(0, shownCount);
  const remaining = changes.length - shown.length;

  return (
    <div data-testid="sensor-changes" style={{ fontSize: 12.5 }}>
      <div className="fw-semibold mb-1" style={{ color: 'var(--progeo-blue)' }}>
        {t('analyse_compare_changes_title')}
      </div>
      <div className="text-muted mb-2" style={{ fontSize: 11.5 }}>
        {t('analyse_compare_changes_hint')}
      </div>
      {changes.length === 0 ? (
        <div className="text-muted">{t('analyse_compare_changes_empty')}</div>
      ) : (
        <table
          className="table table-sm table-hover mb-2"
          style={{ fontSize: 12.5 }}
        >
          <thead>
            <tr className="text-muted">
              <th scope="col" className="fw-normal">
                {t('measurement_compare_pair_label')}
              </th>
              <th scope="col" className="fw-normal text-end">
                <Swatch color={wpColor} />
                {t('analyse_compare_col_wp')}
              </th>
              <th scope="col" className="fw-normal text-end">
                <Swatch color={epColor} />
                {t('analyse_compare_col_ep')}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((change) => {
              const selected = selectedSensors.includes(change.sensor);
              return (
                <tr
                  key={change.sensor}
                  style={{ cursor: onSensorSelect ? 'pointer' : undefined }}
                  title={t(
                    selected
                      ? 'analyse_compare_row_remove'
                      : 'analyse_compare_row_add',
                    {
                      sensor: change.sensor + 1,
                    },
                  )}
                  aria-selected={selected}
                  onClick={() => onSensorSelect?.(change.sensor)}
                  onMouseEnter={() => onSensorHover?.(change.sensor)}
                  onMouseLeave={() => onSensorHover?.(null)}
                >
                  <td>
                    {t('measurement_compare_pair_label')} {change.sensor + 1}
                    {selected && (
                      <CheckLg className="ms-1 text-primary" size={12} />
                    )}
                  </td>
                  <td
                    className="text-end"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatChange(change.wpChange)}
                  </td>
                  <td
                    className="text-end"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatChange(change.epChange)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {remaining > 0 && (
        <Button
          size="sm"
          variant="outline-primary"
          className="py-0"
          style={{ fontSize: 12 }}
          onClick={() => setShownCount((count) => count + CHANGES_PAGE)}
        >
          {t('analyse_compare_more', {
            count: Math.min(CHANGES_PAGE, remaining),
            total: remaining,
          })}
        </Button>
      )}
    </div>
  );
};

export default SensorChangesPanel;
