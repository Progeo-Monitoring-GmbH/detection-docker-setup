import { Button, Form, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { HEAT_PROFILES, type HeatProfile } from './sensorHeatmapTypes';

type Toggle = { value: boolean; onChange: (value: boolean) => void };

type HeatmapDisplayControlsProps = {
  /** The sensor markers (dots). */
  dots: Toggle;
  /** The area selection mode (drag selects sensors) - null: not offered. */
  area?: Toggle | null;
  /** smartex® dm: the band lines - null without lines. */
  lines?: Toggle | null;
  /** Staff: the heat scaled to the period's highest value - `forced` while
   * the profile has no threshold to scale against. null: not offered. */
  normalize?: (Toggle & { forced: boolean }) | null;
  /** Staff: the value per sensor the heat shows - null: not offered. */
  profile?: { value: HeatProfile; onChange: (value: HeatProfile) => void; loading?: boolean } | null;
};

const toggleStyle = { fontSize: 12, paddingInline: 10, borderRadius: 'var(--progeo-radius-pill)' };

const ToggleButton = ({ label, title, toggle, disabled = false }: {
  label: string;
  title?: string;
  toggle: Toggle;
  disabled?: boolean;
}) => (
  <Button
    size="sm"
    variant={toggle.value ? 'primary' : 'light'}
    aria-pressed={toggle.value}
    title={title}
    disabled={disabled}
    className="py-0"
    style={toggleStyle}
    onClick={() => toggle.onChange(!toggle.value)}
  >
    {label}
  </Button>
);

/**
 * What the heatmap shows, floating over its top left (beside the zoom
 * buttons): the dots and - smartex® dm - the band lines; staff also the heat
 * normalization and the profile (|WP - EP|, WP, EP, WP + EP).
 */
const HeatmapDisplayControls = ({
  dots,
  area = null,
  lines = null,
  normalize = null,
  profile = null,
}: HeatmapDisplayControlsProps) => {
  const { t } = useTranslation();
  return (
    <div
      data-testid="heatmap-display-controls"
      className="d-flex flex-wrap align-items-center gap-1"
      style={{
        position: 'absolute',
        left: 52,
        top: 8,
        maxWidth: 'calc(100% - 120px)',
        padding: 4,
        background: 'rgba(255, 255, 255, 0.88)',
        borderRadius: 'var(--progeo-radius-pill)',
        boxShadow: '0 2px 8px rgba(11, 54, 89, .18)',
        zIndex: 2,
      }}
    >
      <ToggleButton label={t('heatmap_show_dots')} title={t('heatmap_show_dots_hint')} toggle={dots} />
      {lines && <ToggleButton label={t('heatmap_show_lines')} title={t('heatmap_show_lines_hint')} toggle={lines} />}
      {area && <ToggleButton label={t('heatmap_area_select')} title={t('heatmap_area_select_hint')} toggle={area} />}
      {normalize && (
        <ToggleButton
          label={t('heatmap_normalize')}
          title={t(normalize.forced ? 'heatmap_normalize_forced' : 'heatmap_normalize_hint')}
          toggle={{ value: normalize.value || normalize.forced, onChange: normalize.onChange }}
          disabled={normalize.forced}
        />
      )}
      {profile && (
        <>
          <Form.Select
            size="sm"
            aria-label={t('heatmap_profile')}
            title={t('heatmap_profile_hint')}
            value={profile.value}
            onChange={(event) => profile.onChange(event.target.value as HeatProfile)}
            style={{ width: 'auto', fontSize: 12, paddingBlock: 1, borderRadius: 'var(--progeo-radius-pill)' }}
          >
            {HEAT_PROFILES.map((value) => (
              <option key={value} value={value}>
                {t(`heatmap_profile_${value}`)}
              </option>
            ))}
          </Form.Select>
          {profile.loading && <Spinner size="sm" animation="border" className="text-muted mx-1" />}
        </>
      )}
    </div>
  );
};

export default HeatmapDisplayControls;
