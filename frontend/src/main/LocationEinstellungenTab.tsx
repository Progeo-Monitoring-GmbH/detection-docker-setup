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
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';
import DeviceConfigPanel, {
  type ConfigDevice,
} from '../components/device/DeviceConfigPanel';
import type { PortalOutletContext } from './LocationPortalLayout';
import { getProjectTypeLabel } from './projectType';
import { useProgeoRole } from './roleModel';

/** One sensor of the object; `id` is null while it has no ProgeoMeasurePoint. */
type SensorThreshold = {
  sensor_order: number;
  id: number | null;
  name: string | null;
  threshold: number | null;
};

const thresholdInputStyle = {
  width: 120,
  height: 30,
  border: 'none',
  borderRadius: 8,
  background: 'var(--progeo-surface)',
  padding: '0 8px',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: 'var(--progeo-blue)',
};

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
 * Einstellungen: object-level + per-measurement-point thresholds,
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
  const authUser = auth?.user as {
    is_staff?: boolean;
    is_superuser?: boolean;
  } | null;
  // The backend lets staff and superusers assign ProGeo staff / an
  // Objektleitung by email (locations_viewset._objektleitung_user).
  const canAssignByEmail = Boolean(
    authUser?.is_staff || authUser?.is_superuser,
  );

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

  // -- Schwellwerte ---------------------------------------------------
  const [threshold, setThreshold] = useState(
    String(location?.alarm_threshold ?? ''),
  );
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [sensors, setSensors] = useState<SensorThreshold[]>([]);
  // Edited-but-unsaved inputs, keyed by sensor_order ('' = clear override).
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [pointsOpen, setPointsOpen] = useState(false);
  const [pointsLoading, setPointsLoading] = useState(true);
  const [savingPoints, setSavingPoints] = useState(false);

  const loadPoints = useCallback(() => {
    setPointsLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurepoints/`,
      (response) => {
        setSensors((response?.data?.sensors || []) as SensorThreshold[]);
        setDrafts({});
        setPointsLoading(false);
      },
      () => setPointsLoading(false),
    );
  }, [auth, locationId]);

  useEffect(() => {
    loadPoints();
  }, [loadPoints]);

  const saveObjectThreshold = () => {
    setSavingThreshold(true);
    void axiosConfig.perform_patch(
      auth,
      `/v1/location/${locationId}/`,
      { alarm_threshold: threshold ? Number(threshold) : null },
      () => {
        showSuccessBar(enqueueSnackbar, t('einstell_saved'));
        setSavingThreshold(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not save', error);
        setSavingThreshold(false);
      },
    );
  };

  const changedSensors = sensors.filter(
    (sensor) =>
      sensor.sensor_order in drafts &&
      drafts[sensor.sensor_order] !== String(sensor.threshold ?? ''),
  );

  // Saves every edited sensor at once; the backend updates its
  // ProgeoMeasurePoint or creates one if the sensor has none yet.
  const savePointThresholds = () => {
    setSavingPoints(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/measurepoints/`,
      {
        points: changedSensors.map((sensor) => {
          const value = drafts[sensor.sensor_order].trim();
          return {
            sensor_order: sensor.sensor_order,
            threshold: value === '' ? null : Number(value),
          };
        }),
      },
      () => {
        showSuccessBar(enqueueSnackbar, t('einstell_saved'));
        setSavingPoints(false);
        loadPoints();
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not save thresholds', error);
        setSavingPoints(false);
      },
    );
  };

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
        setStaffRules(
          rules.filter((rule) => rule.is_staff || rule.objektleitung),
        );
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
        maxWidth: 900,
      }}
    >
      <PanelCard title={t('einstell_section_thresholds')}>
        <div
          style={{
            background: 'var(--progeo-surface)',
            borderRadius: 13,
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                {t('einstell_alarm_threshold')}
              </div>
              <div style={{ fontSize: 12, color: '#8B8383', marginTop: 2 }}>
                {t('einstell_alarm_threshold_hint')}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                value={threshold}
                readOnly={!canEdit}
                onChange={(event) => setThreshold(event.target.value)}
                style={{
                  height: 38,
                  width: 110,
                  border: 'none',
                  borderRadius: 10,
                  background: 'var(--progeo-track-soft)',
                  padding: '0 12px',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  color: 'var(--progeo-blue)',
                }}
              />
              <span style={{ fontSize: 13, color: '#8B8383' }}>mV</span>
              {canEdit && (
                <PillButton
                  label={t('einstell_save')}
                  onClick={saveObjectThreshold}
                  disabled={savingThreshold}
                />
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setPointsOpen((open) => !open)}
            aria-expanded={pointsOpen}
            style={{
              alignSelf: 'flex-start',
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
            {pointsOpen ? t('einstell_points_hide') : t('einstell_points_show')}
          </button>

          {pointsOpen && (
            <div
              style={{
                background: 'var(--progeo-track-soft)',
                borderRadius: 11,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 10,
                  padding: '9px 12px',
                  fontSize: 10.5,
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: '#8B8383',
                  fontWeight: 500,
                }}
              >
                <span>{t('status_col_mp')}</span>
                <span>{t('einstell_points_threshold')}</span>
              </div>
              {pointsLoading ? (
                <div className="d-flex justify-content-center py-3 text-muted">
                  <Spinner animation="border" size="sm" />
                </div>
              ) : sensors.length === 0 ? (
                <div
                  style={{
                    padding: '10px 12px',
                    fontSize: 12.5,
                    color: '#8B8383',
                    borderTop: '1px solid #E4E0E0',
                  }}
                >
                  {t('einstell_points_empty')}
                </div>
              ) : (
                sensors.map((sensor) => (
                  <div
                    key={sensor.sensor_order}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 10,
                      padding: '8px 12px',
                      fontSize: 12.5,
                      borderTop: '1px solid #E4E0E0',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>
                      {sensor.name ||
                        t('einstell_points_sensor', {
                          sensor: sensor.sensor_order,
                        })}
                    </span>
                    <span
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <input
                        type="number"
                        value={
                          drafts[sensor.sensor_order] ??
                          String(sensor.threshold ?? '')
                        }
                        readOnly={!canEdit}
                        placeholder={
                          location?.alarm_threshold != null
                            ? `${t('einstell_points_inherited')} (${location.alarm_threshold})`
                            : t('einstell_points_inherited')
                        }
                        onChange={(event) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [sensor.sensor_order]: event.target.value,
                          }))
                        }
                        style={thresholdInputStyle}
                      />
                      <span style={{ fontSize: 11.5, color: '#8B8383' }}>
                        mV
                      </span>
                    </span>
                  </div>
                ))
              )}
              {canEdit && sensors.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    borderTop: '1px solid #E4E0E0',
                    flexWrap: 'wrap',
                  }}
                >
                  <PillButton
                    label={t('einstell_save')}
                    onClick={savePointThresholds}
                    disabled={savingPoints || changedSensors.length === 0}
                  />
                  <span style={{ fontSize: 11.5, color: '#8B8383' }}>
                    {t('einstell_points_hint')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </PanelCard>

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
