import { useEffect, useState } from 'react';
import { Button, Form, Modal } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import axiosConfig from '../../axiosConfig';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';

export type LocationEditRow = {
  id: number;
  name?: string | null;
  city?: string | null;
  address?: string | null;
  plz?: string | null;
  manager?: string | null;
  telefon?: string | null;
  mail?: string | null;
  project_id?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  alarm_threshold?: number | null;
  device_count?: number;
  has_device?: boolean;
};

type EditLocationForm = {
  id: number | null;
  name: string;
  plz: string;
  address: string;
  city: string;
  manager: string;
  telefon: string;
  mail: string;
  project_id: string;
  latitude: string;
  longitude: string;
  alarm_threshold: string;
};

const EMPTY_EDIT_FORM: EditLocationForm = {
  id: null,
  name: '',
  plz: '',
  address: '',
  city: '',
  manager: '',
  telefon: '',
  mail: '',
  project_id: '',
  latitude: '',
  longitude: '',
  alarm_threshold: '',
};

type LocationEditModalProps = {
  show: boolean;
  location: LocationEditRow | null;
  onHide: () => void;
  onSaved: (updated: LocationEditRow) => void;
};

const parseOptionalInt = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const parseOptionalFloat = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
};

const LocationEditModal = ({
  show,
  location,
  onHide,
  onSaved,
}: LocationEditModalProps) => {
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [form, setForm] = useState<EditLocationForm>(EMPTY_EDIT_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!show || !location) {
      setForm(EMPTY_EDIT_FORM);
      return;
    }

    setForm({
      id: location.id,
      name: location.name || '',
      plz: location.plz || '',
      address: location.address || '',
      city: location.city || '',
      manager: location.manager || '',
      telefon: location.telefon || '',
      mail: location.mail || '',
      project_id:
        location.project_id === null || location.project_id === undefined
          ? ''
          : String(location.project_id),
      latitude:
        location.latitude === null || location.latitude === undefined
          ? ''
          : String(location.latitude),
      longitude:
        location.longitude === null || location.longitude === undefined
          ? ''
          : String(location.longitude),
      alarm_threshold:
        location.alarm_threshold === null ||
        location.alarm_threshold === undefined
          ? ''
          : String(location.alarm_threshold),
    });
  }, [show, location]);

  const handleSave = () => {
    if (!form.id) {
      return;
    }

    const payload = {
      name: form.name.trim() || null,
      plz: form.plz.trim() || null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      manager: form.manager.trim() || null,
      telefon: form.telefon.trim() || null,
      mail: form.mail.trim() || null,
      // project_id is read-only: it names the location's project database
      // (the backend ignores it on updates as well).
      latitude: parseOptionalFloat(form.latitude),
      longitude: parseOptionalFloat(form.longitude),
      alarm_threshold: parseOptionalInt(form.alarm_threshold),
    };

    setSaving(true);
    axiosConfig.updateToken();
    void axiosConfig.holder
      .patch(`/v1/location/${form.id}/`, payload)
      .then((response) => {
        const updated = (response?.data || {}) as LocationEditRow;
        onSaved(updated);
        setSaving(false);
        showSuccessBar(enqueueSnackbar, t('location_edit_saved'));
      })
      .catch((error) => {
        showRequestError(enqueueSnackbar, t('location_edit_error'), error);
        setSaving(false);
      });
  };

  const handleClose = () => {
    if (saving) {
      return;
    }
    onHide();
  };

  return (
    <Modal show={show} onHide={handleClose} centered size="lg">
      <Modal.Header closeButton>
        <Modal.Title>{t('location_edit_title')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="row g-3">
          <div className="col-md-6">
            <Form.Label>{t('objekt_field_project_name')}</Form.Label>
            <Form.Control
              value={form.name}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, name: event.target.value }))
              }
            />
          </div>
          <div className="col-md-3">
            <Form.Label>{t('objekt_field_plz')}</Form.Label>
            <Form.Control
              value={form.plz}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, plz: event.target.value }))
              }
            />
          </div>
          <div className="col-md-3">
            <Form.Label>{t('objekt_field_project_nr')}</Form.Label>
            <Form.Control
              value={form.project_id}
              readOnly
              disabled
              title={t('location_edit_project_nr_hint')}
            />
          </div>
          <div className="col-md-8">
            <Form.Label>{t('objekt_field_street')}</Form.Label>
            <Form.Control
              value={form.address}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, address: event.target.value }))
              }
            />
          </div>
          <div className="col-md-4">
            <Form.Label>{t('objekt_field_city')}</Form.Label>
            <Form.Control
              value={form.city}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, city: event.target.value }))
              }
            />
          </div>
          <div className="col-md-4">
            <Form.Label>{t('objekt_field_manager')}</Form.Label>
            <Form.Control
              value={form.manager}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, manager: event.target.value }))
              }
            />
          </div>
          <div className="col-md-4">
            <Form.Label>{t('objekt_field_phone')}</Form.Label>
            <Form.Control
              value={form.telefon}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, telefon: event.target.value }))
              }
            />
          </div>
          <div className="col-md-4">
            <Form.Label>{t('objekt_field_email')}</Form.Label>
            <Form.Control
              type="email"
              value={form.mail}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, mail: event.target.value }))
              }
            />
          </div>
          <div className="col-md-4">
            <Form.Label>{t('location_edit_latitude')}</Form.Label>
            <Form.Control
              value={form.latitude}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, latitude: event.target.value }))
              }
            />
          </div>
          <div className="col-md-4">
            <Form.Label>{t('location_edit_longitude')}</Form.Label>
            <Form.Control
              value={form.longitude}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, longitude: event.target.value }))
              }
            />
          </div>
          <div className="col-md-4">
            <Form.Label>{t('objekt_field_alarm_threshold')}</Form.Label>
            <Form.Control
              value={form.alarm_threshold}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  alarm_threshold: event.target.value,
                }))
              }
            />
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleClose} disabled={saving}>
          {t('location_edit_cancel')}
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? t('location_edit_saving') : t('location_edit_save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default LocationEditModal;
