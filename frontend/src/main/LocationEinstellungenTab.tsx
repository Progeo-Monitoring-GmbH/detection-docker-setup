import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import {
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';
import DeviceConfigPanel, {
  type ConfigDevice,
} from '../components/device/DeviceConfigPanel';
import type { PortalOutletContext } from './LocationPortalLayout';
import ThresholdMixerPanel from './ThresholdMixerPanel';
import { getProjectTypeLabel } from './projectType';
import { useProgeoRole } from './roleModel';
import { staffFlags } from './access';

type Device = ConfigDevice & {
  hardware: string | null;
  pull_resistance: number | null;
};

type AccessRule = {
  id: number;
  user?: number | null;
  user_name?: string | null;
  user_email?: string | null;
  is_staff?: boolean;
  objektleitung?: boolean;
  transport?: number | null;
  type?: number | null;
};

type StaffUser = {
  id: number;
  username: string;
  email?: string | null;
};

type ProjectTypeOption = { value: number; label: string };

const selectStyle = {
  height: 40,
  border: 'none',
  borderRadius: 11,
  background: 'var(--progeo-surface)',
  boxShadow: '0 1px 4px rgba(11,54,89,.09)',
  padding: '0 13px',
  fontFamily: 'inherit',
  fontSize: 14,
  color: 'var(--progeo-blue)',
};

const fieldLabelStyle = {
  fontSize: 11,
  letterSpacing: '.07em',
  textTransform: 'uppercase' as const,
  color: '#8B8383',
  fontWeight: 500,
};

const addRowInputStyle = {
  height: 38,
  minWidth: 220,
  border: 'none',
  borderRadius: 10,
  background: 'var(--progeo-track-soft)',
  padding: '0 12px',
  fontFamily: 'inherit',
  fontSize: 13.5,
  color: 'var(--progeo-blue)',
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
  gap: '14px 18px',
};

/**
 * Einstellungen: object-level + per-measurement-point thresholds (the
 * ThresholdMixerPanel),
 * per-device system config (+ the new "PE geschaltet" flag), and
 * Objektleitung (responsible ProGeo staff, reusing ProgeoAccess/the same
 * access endpoints as Rechte, filtered to staff users - no separate
 * relation needed).
 */
const LocationEinstellungenTab = () => {
  const { location, locationId } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();
  const { t } = useTranslation();
  const role = useProgeoRole();
  // The backend lets staff and superusers assign ProGeo staff / an
  // Objektleitung by email (locations_viewset._objektleitung_user).
  const canAssignByEmail = staffFlags(auth?.user).isStaffOrSuperuser;

  // Each setting is gated by the permission its endpoint checks:
  // PATCH /v1/location/ + measurepoints -> module_locations_edit,
  // PATCH /v1/device/ -> module_devices_edit, access (Objektleitung)
  // -> module_notifications_add (assign) / module_notifications_edit (remove).
  const canEdit = hasPermission('module_locations_edit');
  const canEditDevices = hasPermission('module_devices_edit');
  const canAssignStaff = hasPermission('module_notifications_add');
  const canRemoveStaff = hasPermission('module_notifications_edit');
  // Same rule as the Objekt tab's product field.
  const canEditProduct = role === 'progeo-admin';

  // -- Systemeinstellungen ---------------------------------------------
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  // Device ids whose config/device_config.lua editor is expanded.
  const [configOpen, setConfigOpen] = useState<Record<number, boolean>>({});
  // Edited (and written into each device's config) inside DeviceConfigPanel.
  const [peGeschaltet, setPeGeschaltet] = useState(
    Boolean(location?.pe_geschaltet),
  );

  useEffect(() => {
    setDevicesLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/devices/`,
      (response) => {
        setDevices((response?.data?.devices || []) as Device[]);
        setDevicesLoading(false);
      },
      () => setDevicesLoading(false),
    );
  }, [auth, locationId]);

  // Produkt = ProgeoLocation.project_type (PROJECT_TYPE_CHOICES), not a
  // device field; options come from the backend like on the Objekt tab.
  // The last choice made here wins over the outlet's (possibly stale)
  // location; keyed by locationId so switching objects drops it.
  const [projectTypeDraft, setProjectTypeDraft] = useState<{
    locationId: typeof locationId;
    value: string;
  } | null>(null);
  const projectType =
    projectTypeDraft?.locationId === locationId
      ? projectTypeDraft.value
      : String(location?.project_type ?? '');
  const [projectTypeOptions, setProjectTypeOptions] = useState<
    ProjectTypeOption[]
  >([]);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/location/project-types/',
      (response) => {
        setProjectTypeOptions(
          (response?.data?.project_types || []) as ProjectTypeOption[],
        );
      },
      () => {
        // Non-fatal: the read-only label below works without the options.
      },
    );
  }, [auth]);

  const projectTypeLabel = (value: number | null) =>
    getProjectTypeLabel(
      t,
      value,
      projectTypeOptions.find((option) => option.value === value)?.label,
    );

  const saveProjectType = (value: string) => {
    const previous = projectType;
    setProjectTypeDraft({ locationId, value });
    void axiosConfig.perform_patch(
      auth,
      `/v1/location/${locationId}/`,
      { project_type: value === '' ? null : Number(value) },
      () => showSuccessBar(enqueueSnackbar, t('einstell_saved')),
      (error) => {
        setProjectTypeDraft({ locationId, value: previous });
        showRequestError(enqueueSnackbar, 'Could not save', error);
      },
    );
  };

  // -- Rain check (ProgeoLocation.rain_check_enabled) --------------------
  // Like the product: the last choice made here wins over the outlet's
  // location, keyed by locationId so switching objects drops it.
  const [rainCheckDraft, setRainCheckDraft] = useState<{
    locationId: typeof locationId;
    value: boolean;
  } | null>(null);
  const rainCheck =
    rainCheckDraft?.locationId === locationId
      ? rainCheckDraft.value
      : Boolean(location?.rain_check_enabled);
  const hasCoordinates =
    location?.latitude != null && location?.longitude != null;

  const saveRainCheck = (value: boolean) => {
    const previous = rainCheck;
    setRainCheckDraft({ locationId, value });
    void axiosConfig.perform_patch(
      auth,
      `/v1/location/${locationId}/`,
      { rain_check_enabled: value },
      () => showSuccessBar(enqueueSnackbar, t('einstell_saved')),
      (error) => {
        setRainCheckDraft({ locationId, value: previous });
        showRequestError(enqueueSnackbar, 'Could not save', error);
      },
    );
  };

  // -- Objektleitung (staff access, reuses ProgeoAccess/access endpoints) --
  const [staffRules, setStaffRules] = useState<AccessRule[]>([]);
  const [staffCandidates, setStaffCandidates] = useState<StaffUser[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [addStaffId, setAddStaffId] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addingEmail, setAddingEmail] = useState(false);

  const loadStaffAccess = useCallback(() => {
    setStaffLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/access/`,
      (response) => {
        const rules = (response?.data?.access || []) as AccessRule[];
        // Only assigned Objektleitung - a staff member's own notification
        // rule (set on the Rechte tab) is no assignment.
        setStaffRules(rules.filter((rule) => rule.objektleitung));
        setStaffCandidates((response?.data?.staff_users || []) as StaffUser[]);
        setStaffLoading(false);
      },
      () => setStaffLoading(false),
    );
  }, [auth, locationId]);

  useEffect(() => {
    loadStaffAccess();
  }, [loadStaffAccess]);

  const availableStaff = staffCandidates.filter(
    (staff) => !staffRules.some((rule) => rule.user === staff.id),
  );

  const addStaff = () => {
    if (!addStaffId) {
      return;
    }
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/`,
      {
        user_id: Number(addStaffId),
        transport: 1,
        type: 1,
        objektleitung: true,
      },
      (response) => {
        const saved = response?.data?.access as AccessRule | undefined;
        if (saved) {
          setStaffRules((prev) => [...prev, saved]);
        }
        setAddStaffId('');
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not assign staff', error);
      },
    );
  };

  // Objektleitung by email: the backend reuses the account with that email
  // or creates one (no password), so alarm emails reach that address via
  // the usual ProgeoAccess rule.
  const addByEmail = () => {
    const email = addEmail.trim();
    if (!email) {
      return;
    }
    setAddingEmail(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/`,
      { email, transport: 1, type: 1 },
      (response) => {
        const saved = response?.data?.access as AccessRule | undefined;
        if (saved) {
          setStaffRules((prev) => [
            ...prev.filter((rule) => rule.id !== saved.id),
            saved,
          ]);
        }
        setAddEmail('');
        setAddingEmail(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not assign email', error);
        setAddingEmail(false);
      },
    );
  };

  const removeStaff = (rule: AccessRule) => {
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/delete/`,
      { id: rule.id },
      () => setStaffRules((prev) => prev.filter((r) => r.id !== rule.id)),
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not remove staff', error);
      },
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <ThresholdMixerPanel
        // A fresh panel (drafts, selection) per object.
        key={locationId}
        locationId={locationId}
        initialObjectThreshold={location?.alarm_threshold ?? null}
        canEdit={canEdit}
      />

      <PanelCard title={t('einstell_section_system')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              background: 'var(--progeo-surface)',
              borderRadius: 13,
              padding: '13px 16px',
            }}
          >
            <div style={gridStyle}>
              {canEditProduct && projectTypeOptions.length > 0 ? (
                <label
                  style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
                >
                  <span style={fieldLabelStyle}>{t('einstell_product')}</span>
                  <select
                    value={projectType}
                    onChange={(event) => saveProjectType(event.target.value)}
                    style={selectStyle}
                  >
                    {projectType === '' && <option value="">–</option>}
                    {projectTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {projectTypeLabel(option.value)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <LabeledInput
                  label={t('einstell_product')}
                  value={projectTypeLabel(
                    projectType === '' ? null : Number(projectType),
                  )}
                  readOnly
                />
              )}
            </div>
          </div>

          <div
            style={{
              background: 'var(--progeo-surface)',
              borderRadius: 13,
              padding: '13px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                {t('einstell_rain_check')}
              </div>
              <div style={{ fontSize: 12, color: '#8B8383', marginTop: 2 }}>
                {t(
                  rainCheck && !hasCoordinates
                    ? 'einstell_rain_check_no_coordinates'
                    : 'einstell_rain_check_hint',
                )}
              </div>
            </div>
            <SegmentedControl
              options={[
                { value: 'ja', label: t('einstell_yes') },
                { value: 'nein', label: t('einstell_no') },
              ]}
              value={rainCheck ? 'ja' : 'nein'}
              disabled={!canEdit}
              onChange={(value) => {
                if (canEdit && (value === 'ja') !== rainCheck) {
                  saveRainCheck(value === 'ja');
                }
              }}
            />
          </div>

          {devicesLoading ? (
            <div className="d-flex justify-content-center py-3 text-muted">
              <Spinner animation="border" size="sm" />
            </div>
          ) : (
            devices.map((device) => (
              <div
                key={device.id}
                style={{
                  background: 'var(--progeo-surface)',
                  borderRadius: 13,
                  padding: '13px 16px',
                }}
              >
                <div
                  style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}
                >
                  {device.hardware || `#${device.id}`}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setConfigOpen((prev) => ({
                      ...prev,
                      [device.id]: !prev[device.id],
                    }))
                  }
                  aria-expanded={Boolean(configOpen[device.id])}
                  style={{
                    marginTop: 12,
                    marginBottom: configOpen[device.id] ? 10 : 0,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    fontFamily: 'inherit',
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: 'var(--progeo-orange)',
                    cursor: 'pointer',
                  }}
                >
                  {configOpen[device.id]
                    ? t('einstell_config_hide')
                    : t('einstell_config_show')}
                </button>
                {configOpen[device.id] && (
                  <DeviceConfigPanel
                    device={device}
                    canEdit={canEditDevices}
                    locationId={locationId}
                    peSwitched={peGeschaltet}
                    onPullResistanceSaved={(value) =>
                      setDevices((prev) =>
                        prev.map((d) =>
                          d.id === device.id
                            ? { ...d, pull_resistance: value }
                            : d,
                        ),
                      )
                    }
                    onPeSwitchedSaved={setPeGeschaltet}
                  />
                )}
              </div>
            ))
          )}
          {!devicesLoading && devices.length === 0 && (
            <span style={{ fontSize: 12.5, color: '#8B8383' }}>
              {t('einstell_no_devices')}
            </span>
          )}
        </div>
      </PanelCard>

      <PanelCard title={t('einstell_section_objektleitung')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {staffLoading ? (
            <div className="d-flex justify-content-center py-3 text-muted">
              <Spinner animation="border" size="sm" />
            </div>
          ) : (
            <>
              {staffRules.map((rule) => (
                <div
                  key={rule.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    background: 'var(--progeo-surface)',
                    borderRadius: 13,
                    padding: '12px 16px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 150 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                      {rule.user_name}
                    </div>
                    <div
                      style={{ fontSize: 12, color: '#8B8383', marginTop: 2 }}
                    >
                      {rule.user_email}
                    </div>
                  </div>
                  {canRemoveStaff && (
                    <PillButton
                      variant="ghost"
                      label={t('rechte_revoke')}
                      onClick={() => removeStaff(rule)}
                    />
                  )}
                </div>
              ))}
              {staffRules.length === 0 && (
                <span style={{ fontSize: 12.5, color: '#8B8383' }}>
                  {t('einstell_objektleitung_empty')}
                </span>
              )}
              {canAssignStaff && (
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <select
                    value={addStaffId}
                    onChange={(event) => setAddStaffId(event.target.value)}
                    style={addRowInputStyle}
                  >
                    <option value="">{t('einstell_select_staff')}</option>
                    {availableStaff.map((staff) => (
                      <option key={staff.id} value={staff.id}>
                        {staff.username}
                      </option>
                    ))}
                  </select>
                  <PillButton label={t('einstell_assign')} onClick={addStaff} />
                </div>
              )}
              {canAssignStaff && canAssignByEmail && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    addByEmail();
                  }}
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <input
                    type="email"
                    required
                    value={addEmail}
                    placeholder={t('einstell_objektleitung_email')}
                    aria-label={t('einstell_objektleitung_email')}
                    onChange={(event) => setAddEmail(event.target.value)}
                    style={addRowInputStyle}
                  />
                  <PillButton
                    label={t('einstell_assign')}
                    onClick={addByEmail}
                    disabled={addingEmail}
                  />
                  <span style={{ fontSize: 11.5, color: '#8B8383' }}>
                    {t('einstell_objektleitung_email_hint')}
                  </span>
                </form>
              )}
            </>
          )}
        </div>
      </PanelCard>
    </div>
  );
};

export default LocationEinstellungenTab;
