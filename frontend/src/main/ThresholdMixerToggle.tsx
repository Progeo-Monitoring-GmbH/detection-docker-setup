import { useState } from 'react';
import { Sliders } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import usePermissions from '../../hooks/usePermissions';
import PillButton from '../components/ui/kit/PillButton';
import ThresholdMixerPanel from './ThresholdMixerPanel';

type ThresholdMixerToggleProps = {
  locationId: number | string;
  initialObjectThreshold: number | null;
  /** After the thresholds were saved - reload what depends on them. */
  onSaved?: () => void;
};

/**
 * The Schwellwerte of the Einstellungen tab (ThresholdMixerPanel) anywhere
 * else: a bar with what they are for, the object threshold and a button that
 * loads them right below it - editable with the same permission as there -
 * and hides them again.
 */
const ThresholdMixerToggle = ({ locationId, initialObjectThreshold, onSaved }: ThresholdMixerToggleProps) => {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const [open, setOpen] = useState(false);

  return (
    <div className="d-flex flex-column gap-3" data-testid="threshold-mixer-toggle">
      <div
        className="d-flex flex-wrap align-items-center gap-3"
        style={{
          background: 'var(--progeo-surface)',
          borderRadius: 12,
          padding: '10px 14px',
          border: `1px solid ${open ? 'rgba(31, 95, 191, 0.35)' : 'transparent'}`,
        }}
      >
        <Sliders size={20} style={{ color: 'var(--progeo-blue)', flexShrink: 0 }} aria-hidden="true" />
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div className="fw-semibold" style={{ fontSize: 13.5 }}>
            {t('thresholds_toggle_title')}
          </div>
          <div className="small text-muted">{t('thresholds_toggle_hint')}</div>
        </div>
        {initialObjectThreshold != null && (
          <span
            className="rounded-pill px-2 small fw-semibold"
            style={{ background: 'var(--progeo-track-soft)', color: 'var(--progeo-blue)' }}
            data-testid="threshold-mixer-object"
          >
            {t('thresholds_toggle_object', { value: initialObjectThreshold })}
          </span>
        )}
        <PillButton
          variant={open ? 'solid' : 'accent'}
          active={open}
          icon={<Sliders size={13} />}
          label={open ? t('thresholds_toggle_hide') : t('thresholds_toggle_load')}
          title={t('thresholds_toggle_hint')}
          onClick={() => setOpen((shown) => !shown)}
        />
      </div>
      {open && (
        <ThresholdMixerPanel
          // A fresh mixer (drafts, selection) per object.
          key={locationId}
          locationId={locationId}
          initialObjectThreshold={initialObjectThreshold}
          canEdit={hasPermission('module_locations_edit')}
          onSaved={onSaved}
          embedded
        />
      )}
    </div>
  );
};

export default ThresholdMixerToggle;
