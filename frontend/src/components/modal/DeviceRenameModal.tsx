import { useEffect, useState } from 'react';
import { Button, Form, Modal, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';

type DeviceName = {
  id: number;
  name: string;
  hardware: string | null;
  type: string | null;
  display_name: string;
};

type DeviceRenameModalProps = {
  show: boolean;
  locationId: number;
  onClose: () => void;
  /** Called after a successful save so the charts can reload. */
  onSaved: () => void;
};

/**
 * Superuser tool: rename all devices of a location in one go. Only the names
 * that were actually changed are sent to POST /v1/location/<pk>/devices/names/.
 */
const DeviceRenameModal = ({ show, locationId, onClose, onSaved }: DeviceRenameModalProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [devices, setDevices] = useState<DeviceName[] | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!show) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/devices/names/`,
      (response) => {
        const list = (response?.data?.devices || []) as DeviceName[];
        setDevices(list);
        setNames(Object.fromEntries(list.map((device) => [device.id, device.name])));
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not load devices', error);
        onClose();
      },
    );
    // Reload whenever the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, locationId]);

  const changed = (devices ?? [])
    .filter((device) => (names[device.id] ?? '').trim() !== device.name)
    .map((device) => ({ id: device.id, name: (names[device.id] ?? '').trim() }));

  const save = () => {
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/devices/names/`,
      { devices: changed },
      () => {
        showSuccessBar(enqueueSnackbar, t('device_rename_done', { count: changed.length }));
        setSaving(false);
        onSaved();
        onClose();
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not rename devices', error);
        setSaving(false);
      },
    );
  };

  return (
    <Modal show={show} onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title>{t('device_rename_title')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {devices === null ? (
          <div className="d-flex justify-content-center py-4 text-muted">
            <Spinner animation="border" className="me-2" /> {t('ui_loading')}
          </div>
        ) : devices.length === 0 ? (
          <div className="text-muted">{t('device_rename_empty')}</div>
        ) : (
          <Form onSubmit={(event) => event.preventDefault()}>
            {devices.map((device) => (
              <Form.Group key={device.id} className="mb-3" controlId={`device-name-${device.id}`}>
                <Form.Label style={{ fontSize: 12.5, color: '#8B8383' }}>
                  {device.hardware || device.type || `#${device.id}`}
                </Form.Label>
                <Form.Control
                  value={names[device.id] ?? ''}
                  maxLength={50}
                  placeholder={device.hardware ?? ''}
                  onChange={(event) =>
                    setNames((current) => ({ ...current, [device.id]: event.target.value }))
                  }
                />
              </Form.Group>
            ))}
          </Form>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          {t('device_rename_cancel')}
        </Button>
        <Button variant="primary" onClick={save} disabled={saving || changed.length === 0}>
          {saving ? '…' : t('device_rename_save', { count: changed.length })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default DeviceRenameModal;
