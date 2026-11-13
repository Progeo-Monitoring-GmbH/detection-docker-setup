import { useState } from 'react';
import { Sliders } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import usePermissions from '../../hooks/usePermissions';
import PillButton from '../components/ui/kit/PillButton';
import ThresholdMixerPanel from './ThresholdMixerPanel';
import './ThresholdMixer.css';
import type { MixerSensor } from './thresholdMixer';

type ThresholdMixerToggleProps = {
  locationId: number | string;
  initialObjectThreshold: number | null;
  /** After the thresholds were saved - reload what depends on them. */
  onSaved?: () => void;
  /** The sensors from the page's loaded data - the mixer requests nothing itself (see ThresholdMixerPanel). */
  loaded?: { sensors: MixerSensor[]; note: string } | null;
};

/**
 * The Schwellwerte of the Einstellungen tab (ThresholdMixerPanel) anywhere
 * else: a bar with what they are for, the object threshold and a button that
 * loads them right below it - editable with the same permission as there -
 * and hides them again.
 */
const ThresholdMixerToggle = ({ locationId, initialObjectThreshold, onSaved, loaded = null }: ThresholdMixerToggleProps) => {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const [open, setOpen] = useState(false);

  return (
    // Open: the bar and the mixer are one framed block (see ThresholdMixer.css).
    <div
      data-testid="threshold-mixer-toggle"
      className={open ? 'threshold-toggle threshold-toggle--open' : 'threshold-toggle'}
    >
      <div className="d-flex flex-wrap align-items-center gap-3 threshold-toggle-bar">
        <Sliders size={20} className="threshold-toggle-icon" aria-hidden="true" />
        <div className="threshold-toggle-text">
          <div className="fw-semibold threshold-toggle-title">
            {t('thresholds_toggle_title')}
          </div>
          <div className="small text-muted">{t('thresholds_toggle_hint')}</div>
        </div>
        {initialObjectThreshold != null && (
          <span
            className="rounded-pill px-2 small fw-semibold threshold-toggle-object"
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
          testId="threshold-mixer-toggle-button"
        />
      </div>
      {open && (
        <div className="threshold-toggle-body" data-testid="threshold-mixer-body">
          <ThresholdMixerPanel
            // A fresh mixer (drafts, selection) per object.
            key={locationId}
            locationId={locationId}
            initialObjectThreshold={initialObjectThreshold}
            canEdit={hasPermission('module_locations_edit')}
            onSaved={onSaved}
            embedded
            loaded={loaded}
          />
        </div>
      )}
    </div>
  );
};

export default ThresholdMixerToggle;
