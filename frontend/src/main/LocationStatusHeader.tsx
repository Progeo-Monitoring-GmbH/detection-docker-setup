import { useEffect, useRef, useState } from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { PencilSquare, Trash } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import {
  errorReason,
  showErrorBar,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import {
  deviceLabelOf,
  type RequestableDevice,
  requestableDevicesOf,
} from './locationStatusViewData';
import './LocationStatusView.css';

/** The devices of the location a measurement can be requested from (none
 * while `enabled` is false) and the one picked - answers of an older
 * location are dropped. */
const useRequestableDevices = (locationId: number, enabled: boolean) => {
  const auth = useAuth();
  // Several devices can belong to one location - the request names one.
  const [devices, setDevices] = useState<RequestableDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const deviceRequest = useRef(0);

  useEffect(() => {
    const request = ++deviceRequest.current;
    const show = (list: RequestableDevice[]) => {
      if (request !== deviceRequest.current) {
        return;
      }
      setDevices(list);
      setSelectedDeviceId(list.length ? list[0].id : null);
    };
    if (!enabled) {
      show([]);
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/request-measurement/devices/`,
      (response) => show(requestableDevicesOf(response?.data?.devices)),
      // No devices to ask: the button stays hidden.
      () => show([]),
    );
    // Once per location - auth changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, locationId]);

  return { devices, selectedDeviceId, setSelectedDeviceId };
};

/** Asks the picked device for a measurement now. */
const useMeasurementRequest = (locationId: number) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [requesting, setRequesting] = useState(false);

  const requestMeasurement = (deviceId: number | null) => {
    if (deviceId == null) {
      return;
    }
    setRequesting(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/request-measurement/`,
      { device: deviceId },
      (response) => {
        showSuccessBar(
          enqueueSnackbar,
          t('status_request_measurement_sent', {
            count: response?.data?.requested_devices ?? 1,
          }),
        );
        setRequesting(false);
      },
      (error) => {
        const reason = errorReason(error);
        showErrorBar(
          enqueueSnackbar,
          t('status_request_measurement_error', { reason }),
        );
        setRequesting(false);
      },
    );
  };

  return { requesting, requestMeasurement };
};

/** Staff: the location in the Django admin - edit / delete. */
const StatusAdminActions = ({
  locationId,
  canEdit,
  canDelete,
}: {
  locationId: number;
  canEdit: boolean;
  canDelete: boolean;
}) => {
  const { t } = useTranslation();
  return (
    <div className="status-admin-actions">
      {canEdit && (
        <Button
          as="a"
          size="sm"
          variant="outline-primary"
          href={`/aadmin/progeo/progeolocation/${locationId}/change/`}
          data-testid="status-django-edit"
        >
          <PencilSquare className="me-1" />
          {t('status_edit_location_django')}
        </Button>
      )}
      {canDelete && (
        <Button
          as="a"
          size="sm"
          variant="outline-danger"
          href={`/aadmin/progeo/progeolocation/${locationId}/delete/`}
          data-testid="status-django-delete"
        >
          <Trash className="me-1" />
          {t('status_delete_location_django')}
        </Button>
      )}
    </div>
  );
};

/** "Request measurement" - with a device dropdown when there are several. */
const MeasurementRequest = ({
  devices,
  selectedDeviceId,
  onSelectDevice,
  requesting,
  onRequest,
}: {
  devices: RequestableDevice[];
  selectedDeviceId: number | null;
  onSelectDevice: (deviceId: number) => void;
  requesting: boolean;
  onRequest: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <div className="status-request" data-testid="status-request">
      {devices.length > 1 && (
        <Form.Select
          data-testid="status-request-device"
          aria-label={t('status_request_measurement_device')}
          title={t('status_request_measurement_device')}
          value={selectedDeviceId ?? ''}
          onChange={(event) => onSelectDevice(Number(event.target.value))}
          disabled={requesting}
          className="status-request-device"
        >
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {deviceLabelOf(device)}
            </option>
          ))}
        </Form.Select>
      )}
      <button
        type="button"
        onClick={onRequest}
        data-testid="status-request-measurement"
        disabled={requesting || selectedDeviceId == null}
        className={`status-request-button${requesting ? ' status-request-button--requesting' : ''}`}
      >
        {requesting && <Spinner size="sm" animation="border" />}
        {t('status_request_measurement')}
      </button>
    </div>
  );
};

/** "Request measurement" and the Django admin links (the location's name
 * and address are in the portal's title, LocationPortalLayout). */
const LocationStatusHeader = ({
  locationId,
  canRequestMeasurement,
  canEditInDjango,
  canDeleteInDjango,
}: {
  locationId: number;
  canRequestMeasurement: boolean;
  canEditInDjango: boolean;
  canDeleteInDjango: boolean;
}) => {
  const { devices, selectedDeviceId, setSelectedDeviceId } =
    useRequestableDevices(locationId, canRequestMeasurement);
  const { requesting, requestMeasurement } = useMeasurementRequest(locationId);
  const showRequest = canRequestMeasurement && devices.length > 0;
  const showAdmin = canEditInDjango || canDeleteInDjango;
  if (!showRequest && !showAdmin) {
    return null;
  }

  return (
    <div className="status-header" data-testid="status-header">
      {showAdmin && (
        <StatusAdminActions
          locationId={locationId}
          canEdit={canEditInDjango}
          canDelete={canDeleteInDjango}
        />
      )}
      {showRequest && (
        <MeasurementRequest
          devices={devices}
          selectedDeviceId={selectedDeviceId}
          onSelectDevice={setSelectedDeviceId}
          requesting={requesting}
          onRequest={() => requestMeasurement(selectedDeviceId)}
        />
      )}
    </div>
  );
};

export default LocationStatusHeader;
