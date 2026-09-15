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
import { formatDateTime } from './dateFormat';
import { getProjectTypeLabel } from './projectType';

type ProjectTypeOption = { value: number; label: string };

type FormState = {
  project_id: string;
  name: string;
  project_type: string;
  address: string;
  plz: string;
  city: string;
  country: string;
  manager: string;
  telefon: string;
  mail: string;
  contact_person: string;
};

const toForm = (location: LocationDetail | null): FormState => ({
  project_id: location?.project_id != null ? String(location.project_id) : '',
  name: location?.name ?? '',
  project_type: location?.project_type != null ? String(location.project_type) : '',
  address: location?.address ?? '',
  plz: location?.plz ?? '',
  city: location?.city ?? '',
  country: location?.country ?? '',
  manager: location?.manager ?? '',
  telefon: location?.telefon ?? '',
  mail: location?.mail ?? '',
  contact_person: location?.contact_person ?? '',
});

/**
 * Objekt tab: the mockup's editable object-detail sections plus a Standort
 * (location) side panel. Only real ProgeoLocation fields are shown - mockup
 * fields with no backend equivalent (Kunden-Nr., Owner, Dachfläche, ...) are
 * intentionally omitted rather than fabricated.
 */
const LocationObjektTab = () => {
  const { location, locationId } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const role = useProgeoRole();

  const [form, setForm] = useState<FormState>(() => toForm(location));
  const [saving, setSaving] = useState(false);
  const [projectTypeOptions, setProjectTypeOptions] = useState<ProjectTypeOption[]>([]);

  useEffect(() => {
    setForm(toForm(location));
  }, [location]);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/location/project-types/',
      (response) => {
        setProjectTypeOptions((response?.data?.project_types || []) as ProjectTypeOption[]);
      },
      () => {
        // Non-fatal: the read-only label fallback below still works from the
        // locally mirrored enum, so a failed fetch just disables editing.
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        project_type: form.project_type ? Number(form.project_type) : null,
        address: form.address,
        plz: form.plz,
        city: form.city,
        country: form.country,
        manager: form.manager,
        telefon: form.telefon,
        mail: form.mail,
        contact_person: form.contact_person,
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

  const projectTypeLabel = (value: number | null) =>
    getProjectTypeLabel(t, value, projectTypeOptions.find((option) => option.value === value)?.label);

  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          flex: '1 1 480px',
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <PanelCard title={t('objekt_section_project')}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
              gap: '14px 18px',
            }}
          >
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
            <LabeledInput
              label={t('objekt_field_online_since')}
              value={formatDateTime(location?.last_updated)}
              readOnly
            />
            <LabeledInput
              label={t('objekt_field_last_measurement')}
              value={formatDateTime(location?.last_measurement_at)}
              readOnly
            />
          </div>
        </PanelCard>

        <PanelCard title={t('objekt_section_product')}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
              gap: '14px 18px',
            }}
          >
            {canEditIdentity && projectTypeOptions.length > 0 ? (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 11,
                    letterSpacing: '.07em',
                    textTransform: 'uppercase',
                    color: '#8B8383',
                    fontWeight: 500,
                  }}
                >
                  {t('objekt_field_project_type')}
                </span>
                <select
                  value={form.project_type}
                  onChange={(event) => set('project_type')(event.target.value)}
                  style={{
                    height: 40,
                    border: 'none',
                    borderRadius: 11,
                    background: 'var(--progeo-surface)',
                    boxShadow: '0 1px 4px rgba(11, 54, 89, .09)',
                    padding: '0 13px',
                    fontFamily: 'inherit',
                    fontSize: 14,
                    color: 'var(--progeo-blue)',
                  }}
                >
                  {projectTypeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {projectTypeLabel(option.value)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <LabeledInput
                label={t('objekt_field_project_type')}
                value={projectTypeLabel(location?.project_type ?? null)}
                readOnly
              />
            )}
            <LabeledInput
              label={t('objekt_field_device_count')}
              value={
                location?.device_count != null
                  ? String(location.device_count)
                  : '–'
              }
              readOnly
            />
          </div>
        </PanelCard>

        <PanelCard title={t('objekt_section_address')}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
              gap: '14px 18px',
            }}
          >
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
            <LabeledInput
              label={t('objekt_field_country')}
              value={form.country}
              onChange={set('country')}
              readOnly={!canEditContact}
            />
          </div>
        </PanelCard>

        <PanelCard title={t('objekt_section_contact')}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
              gap: '14px 18px',
            }}
          >
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
            <LabeledInput
              label={t('objekt_field_contact_person')}
              value={form.contact_person}
              onChange={set('contact_person')}
              readOnly={!canEditIdentity}
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
          <span style={{ fontSize: 12.5, color: '#8B8383' }}>
            {t('ui_no_permission_edit')}
          </span>
        )}
      </div>

      <div style={{ flex: '1 1 300px', minWidth: 0, maxWidth: 360 }}>
        <LocationStandortPanel location={location} />
      </div>
    </div>
  );
};

export default LocationObjektTab;
