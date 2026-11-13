import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { errorReason, showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import LabeledInput from '../components/ui/kit/LabeledInput';
import type { LocationDetail } from './locationTypes';
import type { PortalOutletContext } from './LocationPortalLayout';
import LocationStandortPanel from './LocationStandortPanel';
import { useProgeoRole } from './roleModel';
import { formatDate } from './dateFormat';
import { getProjectTypeLabel } from './projectType';
import './LocationObjektTab.css';

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
  const { location, locationId, setLocation } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const role = useProgeoRole();

  const [form, setForm] = useState<FormState>(() => toForm(location));
  const [saving, setSaving] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
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
      (response) => {
        // The other tabs (product: lines or heatmap, header) see the saved values at once.
        const saved = response?.data;
        if (saved && typeof saved === 'object') {
          setLocation((current) => (current ? { ...current, ...saved } : current));
        }
        showSuccessBar(enqueueSnackbar, t('objekt_saved'));
        setSaving(false);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, t('objekt_save_error', { reason: errorReason(error) }));
        setSaving(false);
      },
    );
  };

  // The backend geocodes the saved address - unsaved edits have to be saved first.
  const savedAddress = toForm(location);
  const addressDirty = (['address', 'plz', 'city', 'country'] as const).some(
    (field) => form[field] !== savedAddress[field],
  );

  const geocode = () => {
    setGeocoding(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/geocode/`,
      {},
      (response) => {
        const { latitude, longitude } = response?.data || {};
        setLocation((prev) => (prev ? { ...prev, latitude, longitude } : prev));
        showSuccessBar(enqueueSnackbar, t('objekt_geocode_done'));
        setGeocoding(false);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, t('objekt_geocode_error', { reason: errorReason(error) }));
        setGeocoding(false);
      },
    );
  };

  const projectTypeLabel = (value: number | null) =>
    getProjectTypeLabel(t, value, projectTypeOptions.find((option) => option.value === value)?.label);

  return (
    <div className="objekt-tab" data-testid="page-location-objekt">
      <div className="objekt-main">
        <PanelCard title={t('objekt_section_project')} testId="objekt-project">
          <div className="objekt-grid">
            <LabeledInput
              testId="objekt-project-nr"
              label={t('objekt_field_project_nr')}
              value={form.project_id}
              readOnly
            />
            <LabeledInput
              testId="objekt-project-name"
              label={t('objekt_field_project_name')}
              value={form.name}
              onChange={set('name')}
              readOnly={!canEditIdentity}
            />
            <LabeledInput
              testId="objekt-online-since"
              label={t('objekt_field_online_since')}
              value={formatDate(location?.last_updated)}
              readOnly
            />
            <LabeledInput
              testId="objekt-last-measurement"
              label={t('objekt_field_last_measurement')}
              value={formatDate(location?.last_measurement_at)}
              readOnly
            />
          </div>
        </PanelCard>

        <PanelCard title={t('objekt_section_product')} testId="objekt-product">
          <div className="objekt-grid">
            {canEditIdentity && projectTypeOptions.length > 0 ? (
              <label className="objekt-field">
                <span className="objekt-field-label">
                  {t('objekt_field_project_type')}
                </span>
                <select
                  value={form.project_type}
                  onChange={(event) => set('project_type')(event.target.value)}
                  className="objekt-select"
                  data-testid="objekt-project-type"
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
                testId="objekt-project-type"
                label={t('objekt_field_project_type')}
                value={projectTypeLabel(location?.project_type ?? null)}
                readOnly
              />
            )}
            <LabeledInput
              testId="objekt-device-count"
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

        <PanelCard title={t('objekt_section_address')} testId="objekt-address">
          <div className="objekt-grid">
            <LabeledInput
              testId="objekt-street"
              label={t('objekt_field_street')}
              value={form.address}
              onChange={set('address')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              testId="objekt-plz"
              label={t('objekt_field_plz')}
              value={form.plz}
              onChange={set('plz')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              testId="objekt-city"
              label={t('objekt_field_city')}
              value={form.city}
              onChange={set('city')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              testId="objekt-country"
              label={t('objekt_field_country')}
              value={form.country}
              onChange={set('country')}
              readOnly={!canEditContact}
            />
          </div>
        </PanelCard>

        <PanelCard title={t('objekt_section_contact')} testId="objekt-contact">
          <div className="objekt-grid">
            <LabeledInput
              testId="objekt-manager"
              label={t('objekt_field_manager')}
              value={form.manager}
              onChange={set('manager')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              testId="objekt-phone"
              label={t('objekt_field_phone')}
              value={form.telefon}
              onChange={set('telefon')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              testId="objekt-email"
              label={t('objekt_field_email')}
              value={form.mail}
              onChange={set('mail')}
              readOnly={!canEditContact}
            />
            <LabeledInput
              testId="objekt-contact-person"
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
              className="objekt-save"
              data-testid="objekt-save"
            >
              {saving ? t('ui_loading') : t('objekt_save')}
            </button>
          </div>
        )}
        {!canEditContact && (
          <span className="objekt-no-permission" data-testid="objekt-no-permission">
            {t('ui_no_permission_edit')}
          </span>
        )}
      </div>

      <div className="objekt-side">
        <LocationStandortPanel
          location={location}
          onGeocode={canEditContact ? geocode : undefined}
          geocoding={geocoding}
          geocodeBlockedReason={addressDirty ? t('objekt_geocode_save_first') : undefined}
        />
      </div>
    </div>
  );
};

export default LocationObjektTab;
