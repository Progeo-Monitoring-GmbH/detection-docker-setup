import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import LabeledInput from '../components/ui/kit/LabeledInput';
import type { LocationDetail } from './locationTypes';
import type { PortalOutletContext } from './LocationPortalLayout';
import LocationStandortPanel from './LocationStandortPanel';
import { useProgeoRole } from './roleModel';

// Mirrors ProgeoLocation.PROJECT_TYPE_CHOICES (progeo/v1/models.py) - a fixed
// Django IntegerChoices enum, safe to hardcode client-side. Brand/product
// names (smartex, geologger, DFH) stay literal; the generic terms go
// through i18n.
const PROJECT_TYPE_LABEL_KEYS: Record<number, string> = {
  0: 'objekt_project_type_unknown',
  4: 'objekt_project_type_development',
  5: 'objekt_project_type_versuchsprojekte',
  99: 'objekt_project_type_sonstige',
};
const PROJECT_TYPE_BRAND_LABELS: Record<number, string> = {
  1: 'smartex',
  2: 'geologger',
  3: 'DFH',
};

type FormState = {
  project_id: string;
  name: string;
  alarm_threshold: string;
  address: string;
  plz: string;
  city: string;
  manager: string;
  telefon: string;
  mail: string;
};

const toForm = (location: LocationDetail | null): FormState => ({
  project_id: location?.project_id != null ? String(location.project_id) : '',
  name: location?.name ?? '',
  alarm_threshold: location?.alarm_threshold != null ? String(location.alarm_threshold) : '',
  address: location?.address ?? '',
  plz: location?.plz ?? '',
  city: location?.city ?? '',
  manager: location?.manager ?? '',
  telefon: location?.telefon ?? '',
  mail: location?.mail ?? '',
});

/**
 * Objekt tab: the mockup's editable object-detail sections plus a Standort
 * (location) side panel. Only real ProgeoLocation fields are shown - mockup
 * fields with no backend equivalent (Kunden-Nr., Owner, Objektleitung
 * ProGeo, Dachfläche, ...) are intentionally omitted rather than fabricated.
 */
const LocationObjektTab = () => {
  const { location, locationId } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const role = useProgeoRole();

  const [form, setForm] = useState<FormState>(() => toForm(location));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(toForm(location));
  }, [location]);

  const canEditContact = role !== 'nutzer';
  const canEditIdentity = role === 'progeo-admin';

  const set = (field: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const save = () => {
    setSaving(true);
    void axiosConfig.perform_patch(
      auth,
      `/v1/location/${locationId}/`,
      {
        name: form.name,
        alarm_threshold: form.alarm_threshold ? Number(form.alarm_threshold) : null,
        address: form.address,
        plz: form.plz,
        city: form.city,
        manager: form.manager,
        telefon: form.telefon,
        mail: form.mail,
      },
      () => {
        showSuccessBar(enqueueSnackbar, t('objekt_saved'));
        setSaving(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, t('objekt_save_error', { reason }));
        setSaving(false);
      },
    );
  };

  const projectTypeLabel =
    location?.project_type != null
      ? PROJECT_TYPE_BRAND_LABELS[location.project_type] ??
        (PROJECT_TYPE_LABEL_KEYS[location.project_type]
          ? t(PROJECT_TYPE_LABEL_KEYS[location.project_type])
          : String(location.project_type))
      : '–';

  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <PanelCard title={t('objekt_section_project')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '14px 18px' }}>
            <LabeledInput
              label={t('objekt_field_project_nr')}
              value={form.project_id}
              readOnly
            />
            <LabeledInput
              label={t('objekt_field_project_name')}
              value={form.name}
              onChange={set('name')}
              readOnly={!canEditIdentity}
            />
          </div>
        </PanelCard>

        <PanelCard title={t('objekt_section_product')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '14px 18px' }}>
            <LabeledInput label={t('objekt_field_project_type')} value={projectTypeLabel} readOnly />
            <LabeledInput
              label={t('objekt_field_device_count')}
              value={location?.device_count != null ? String(location.device_count) : '–'}
              readOnly
            />
            <LabeledInput
              label={t('objekt_field_last_measurement')}
              value={
                location?.last_measurement_at
                  ? new Date(location.last_measurement_at).toLocaleString()
                  : '–'
              }
              readOnly
            />
            <LabeledInput
              label={t('objekt_field_alarm_threshold')}
              value={form.alarm_threshold}
              onChange={set('alarm_threshold')}
              readOnly={!canEditIdentity}
              type="number"
            />
          </div>
        </PanelCard>

        <PanelCard title={t('objekt_section_address')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '14px 18px' }}>
            <LabeledInput
              label={t('objekt_field_street')}
              value={form.address}
              onChange={set('address')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              label={t('objekt_field_plz')}
              value={form.plz}
              onChange={set('plz')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              label={t('objekt_field_city')}
              value={form.city}
              onChange={set('city')}
              readOnly={!canEditContact}
            />
          </div>
        </PanelCard>

        <PanelCard title={t('objekt_section_contact')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '14px 18px' }}>
            <LabeledInput
              label={t('objekt_field_manager')}
              value={form.manager}
              onChange={set('manager')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              label={t('objekt_field_phone')}
              value={form.telefon}
              onChange={set('telefon')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              label={t('objekt_field_email')}
              value={form.mail}
              onChange={set('mail')}
              readOnly={!canEditContact}
            />
          </div>
        </PanelCard>

        {(canEditContact || canEditIdentity) && (
          <div>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              style={{
                height: 40,
                padding: '0 20px',
                border: 'none',
                borderRadius: 10,
                background: 'var(--progeo-orange)',
                color: '#fff',
                fontFamily: 'inherit',
                fontSize: 13.5,
                fontWeight: 500,
                cursor: saving ? 'default' : 'pointer',
                boxShadow: '0 4px 14px rgba(235, 99, 59, .28)',
              }}
            >
              {saving ? t('ui_loading') : t('objekt_save')}
            </button>
          </div>
        )}
        {!canEditContact && (
          <span style={{ fontSize: 12.5, color: '#8B8383' }}>{t('ui_no_permission_edit')}</span>
        )}
      </div>

      <div style={{ flex: '1 1 300px', minWidth: 0, maxWidth: 360 }}>
        <LocationStandortPanel location={location} />
      </div>
    </div>
  );
};

export default LocationObjektTab;
