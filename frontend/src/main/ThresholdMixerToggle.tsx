import { useState } from 'react';
import { Button } from 'react-bootstrap';
import { Sliders } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import usePermissions from '../../hooks/usePermissions';
import ThresholdMixerPanel from './ThresholdMixerPanel';

type ThresholdMixerToggleProps = {
  locationId: number | string;
  initialObjectThreshold: number | null;
  /** After the thresholds were saved - reload what depends on them. */
  onSaved?: () => void;
};

/**
 * The Schwellwerte of the Einstellungen tab (ThresholdMixerPanel) anywhere
 * else: a button loads them right below it - editable with the same
 * permission as there - and hides them again.
 */
const ThresholdMixerToggle = ({ locationId, initialObjectThreshold, onSaved }: ThresholdMixerToggleProps) => {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const [open, setOpen] = useState(false);

  return (
    <div className="d-flex flex-column gap-2" data-testid="threshold-mixer-toggle">
      <div>
        <Button
          size="sm"
          variant={open ? 'primary' : 'outline-primary'}
          aria-pressed={open}
          className="d-inline-flex align-items-center gap-1 py-0"
          style={{ fontSize: 12 }}
          title={t('thresholds_toggle_hint')}
          onClick={() => setOpen((shown) => !shown)}
        >
          <Sliders size={12} />
          {open ? t('thresholds_toggle_hide') : t('thresholds_toggle_load')}
        </Button>
      </div>
      {open && (
        <ThresholdMixerPanel
          // A fresh mixer (drafts, selection) per object.
          key={locationId}
          locationId={locationId}
          initialObjectThreshold={initialObjectThreshold}
          canEdit={hasPermission('module_locations_edit')}
          onSaved={onSaved}
        />
      )}
    </div>
  );
};

export default ThresholdMixerToggle;
