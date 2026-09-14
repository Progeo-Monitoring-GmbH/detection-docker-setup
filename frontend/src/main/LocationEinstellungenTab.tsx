import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import LabeledInput from '../components/ui/kit/LabeledInput';
import type { PortalOutletContext } from './LocationPortalLayout';

type MeasurePoint = {
  id: number;
  sensor_order: number;
  threshold: number | null;
};

type Device = {
  id: number;
  hardware: string | null;
  pull_resistance: number | null;
};

type AccessRule = {
  id: number;
  user?: number | null;
  user_name?: string | null;
  user_email?: string | null;
  is_staff?: boolean;
  transport?: number | null;
  type?: number | null;
};

type StaffUser = {
  id: number;
  username: string;
  email?: string | null;
};

// ProgeoDevice.Resistance IntegerChoices (progeo/v1/models.py).
const RESISTANCE_OPTIONS = [
  { value: 136, labelKey: 'einstell_resistance_100k' },
  { value: 72, labelKey: 'einstell_resistance_10k' },
  { value: 40, labelKey: 'einstell_resistance_1k' },
  { value: 24, labelKey: 'einstell_resistance_100' },
  { value: 8, labelKey: 'einstell_resistance_off' },
];

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

  const canEdit = hasPermission('module_locations_edit');

  // -- Schwellwerte ---------------------------------------------------
  const [threshold, setThreshold] = useState(String(location?.alarm_threshold ?? ''));
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [points, setPoints] = useState<MeasurePoint[]>([]);
  const [pointsOpen, setPointsOpen] = useState(false);
  const [pointsLoading, setPointsLoading] = useState(true);

  const loadPoints = useCallback(() => {
    setPointsLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurepoints/`,
      (response) => {
        setPoints((response?.data?.measurepoints || []) as MeasurePoint[]);
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
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not save: ${reason}`);
        setSavingThreshold(false);
      },
    );
  };

  const savePointThreshold = (point: MeasurePoint, value: string) => {
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/measurepoints/`,
      { id: point.id, threshold: value === '' ? null : Number(value) },
      (response) => {
        const saved = response?.data?.measurepoint as MeasurePoint | undefined;
        if (saved) {
          setPoints((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
        }
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not save threshold: ${reason}`);
      },
    );
  };

  // -- Systemeinstellungen ---------------------------------------------
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [peGeschaltet, setPeGeschaltet] = useState(location?.pe_geschaltet ? 'ja' : 'nein');

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

  const saveDeviceField = (device: Device, field: 'hardware' | 'pull_resistance', value: string | number) => {
    void axiosConfig.perform_patch(
      auth,
      `/v1/device/${device.id}/`,
      { [field]: value },
      () => {
        setDevices((prev) => prev.map((d) => (d.id === device.id ? { ...d, [field]: value } : d)));
        showSuccessBar(enqueueSnackbar, t('einstell_saved'));
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not save device: ${reason}`);
      },
    );
  };

  const savePeGeschaltet = (value: string) => {
    setPeGeschaltet(value);
    void axiosConfig.perform_patch(
      auth,
      `/v1/location/${locationId}/`,
      { pe_geschaltet: value === 'ja' },
      () => showSuccessBar(enqueueSnackbar, t('einstell_saved')),
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not save: ${reason}`);
      },
    );
  };

  // -- Objektleitung (staff access, reuses ProgeoAccess/access endpoints) --
  const [staffRules, setStaffRules] = useState<AccessRule[]>([]);
  const [staffCandidates, setStaffCandidates] = useState<StaffUser[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [addStaffId, setAddStaffId] = useState('');

  const loadStaffAccess = useCallback(() => {
    setStaffLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/access/`,
      (response) => {
        const rules = (response?.data?.access || []) as AccessRule[];
        setStaffRules(rules.filter((rule) => rule.is_staff));
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
      { user_id: Number(addStaffId), transport: 1, type: 1 },
      (response) => {
        const saved = response?.data?.access as AccessRule | undefined;
        if (saved) {
          setStaffRules((prev) => [...prev, saved]);
        }
        setAddStaffId('');
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not assign staff: ${reason}`);
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
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not remove staff: ${reason}`);
      },
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 900 }}>
      <PanelCard title={t('einstell_section_thresholds')}>
        <div style={{ background: 'var(--progeo-surface)', borderRadius: 13, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>{t('einstell_alarm_threshold')}</div>
              <div style={{ fontSize: 12, color: '#8B8383', marginTop: 2 }}>{t('einstell_alarm_threshold_hint')}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                value={threshold}
                readOnly={!canEdit}
                onChange={(event) => setThreshold(event.target.value)}
                style={{ height: 38, width: 110, border: 'none', borderRadius: 10, background: 'var(--progeo-track-soft)', padding: '0 12px', fontFamily: 'inherit', fontSize: 14, color: 'var(--progeo-blue)' }}
              />
              <span style={{ fontSize: 13, color: '#8B8383' }}>mV</span>
              {canEdit && (
                <PillButton label={t('einstell_save')} onClick={saveObjectThreshold} disabled={savingThreshold} />
              )}
            </div>
          </div>

          <PillButton
            variant="ghost"
            label={pointsOpen ? t('einstell_points_hide') : t('einstell_points_show')}
            onClick={() => setPointsOpen((open) => !open)}
          />

          {pointsOpen && (
            <div style={{ background: 'var(--progeo-track-soft)', borderRadius: 11, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '9px 12px', fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: '#8B8383', fontWeight: 500 }}>
                <span>{t('status_col_mp')}</span>
                <span>{t('einstell_points_threshold')}</span>
              </div>
              {pointsLoading ? (
                <div className="d-flex justify-content-center py-3 text-muted">
                  <Spinner animation="border" size="sm" />
                </div>
              ) : (
                points.map((point) => (
                  <div key={point.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '8px 12px', fontSize: 12.5, borderTop: '1px solid #E4E0E0', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>#{point.sensor_order}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="number"
                        defaultValue={point.threshold ?? ''}
                        readOnly={!canEdit}
                        placeholder={t('einstell_points_inherited')}
                        onBlur={(event) => savePointThreshold(point, event.target.value)}
                        style={{ width: 90, height: 30, border: 'none', borderRadius: 8, background: 'var(--progeo-surface)', padding: '0 8px', fontFamily: 'inherit', fontSize: 12.5, color: 'var(--progeo-blue)' }}
                      />
                      <span style={{ fontSize: 11.5, color: '#8B8383' }}>mV</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </PanelCard>

      <PanelCard title={t('einstell_section_system')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {devicesLoading ? (
            <div className="d-flex justify-content-center py-3 text-muted">
              <Spinner animation="border" size="sm" />
            </div>
          ) : (
            devices.map((device) => (
              <div key={device.id} style={{ background: 'var(--progeo-surface)', borderRadius: 13, padding: '13px 16px' }}>
                <div style={gridStyle}>
                  <LabeledInput
                    label={t('einstell_product')}
                    value={device.hardware || ''}
                    readOnly={!canEdit}
                    onChange={(value) => setDevices((prev) => prev.map((d) => (d.id === device.id ? { ...d, hardware: value } : d)))}
                  />
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <span style={{ fontSize: 11, letterSpacing: '.07em', textTransform: 'uppercase', color: '#8B8383', fontWeight: 500 }}>
                      {t('einstell_resistance')}
                    </span>
                    <select
                      value={device.pull_resistance ?? ''}
                      disabled={!canEdit}
                      onChange={(event) => saveDeviceField(device, 'pull_resistance', Number(event.target.value))}
                      style={{ height: 40, border: 'none', borderRadius: 11, background: 'var(--progeo-surface)', boxShadow: '0 1px 4px rgba(11,54,89,.09)', padding: '0 13px', fontFamily: 'inherit', fontSize: 14, color: 'var(--progeo-blue)' }}
                    >
                      {RESISTANCE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {canEdit && (
                  <div style={{ marginTop: 10 }}>
                    <PillButton
                      label={t('einstell_save')}
                      onClick={() => saveDeviceField(device, 'hardware', device.hardware || '')}
                    />
                  </div>
                )}
              </div>
            ))
          )}
          {!devicesLoading && devices.length === 0 && (
            <span style={{ fontSize: 12.5, color: '#8B8383' }}>{t('einstell_no_devices')}</span>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, background: 'var(--progeo-surface)', borderRadius: 13, padding: '13px 16px', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>{t('einstell_pe_geschaltet')}</div>
              <div style={{ fontSize: 12, color: '#8B8383', marginTop: 2 }}>{t('einstell_pe_geschaltet_hint')}</div>
            </div>
            <SegmentedControl
              options={[
                { value: 'ja', label: t('einstell_yes') },
                { value: 'nein', label: t('einstell_no') },
              ]}
              value={peGeschaltet}
              onChange={canEdit ? savePeGeschaltet : () => {}}
            />
          </div>
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
                <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'var(--progeo-surface)', borderRadius: 13, padding: '12px 16px', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 150 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>{rule.user_name}</div>
                    <div style={{ fontSize: 12, color: '#8B8383', marginTop: 2 }}>{rule.user_email}</div>
                  </div>
                  {canEdit && (
                    <PillButton variant="ghost" label={t('rechte_revoke')} onClick={() => removeStaff(rule)} />
                  )}
                </div>
              ))}
              {staffRules.length === 0 && (
                <span style={{ fontSize: 12.5, color: '#8B8383' }}>{t('einstell_objektleitung_empty')}</span>
              )}
              {canEdit && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={addStaffId}
                    onChange={(event) => setAddStaffId(event.target.value)}
                    style={{ height: 38, minWidth: 220, border: 'none', borderRadius: 10, background: 'var(--progeo-track-soft)', padding: '0 12px', fontFamily: 'inherit', fontSize: 13.5, color: 'var(--progeo-blue)' }}
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
            </>
          )}
        </div>
      </PanelCard>
    </div>
  );
};

export default LocationEinstellungenTab;
