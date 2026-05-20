import { useContext, useEffect, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { Button, Row, Col, Spinner } from 'react-bootstrap';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';
import { WebsocketContext } from '../components/ws/websocketContext';
import DeviceCard from '../components/device/DeviceCard';
import { CoreModalContext } from '../components/modal/coreModalContext';
import ShowInfoModal from '../components/modal/ShowInfoModal';

const DeviceListView = () => {
  const auth = useAuth();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const { enqueueSnackbar } = useSnackbar();
  const ctx = useContext(WebsocketContext) || {};
  const wsMessage = ctx.wsMessage;
  const [, setShow] = useContext(CoreModalContext);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);

  const fetchDevices = async () => {
    setLoading(true);
    return await axiosConfig.perform_get(
      auth,
      '/v1/status/devices/',
      (response) => {
        setDevices(response?.data?.devices ?? []);
        setLoading(false);
      },
      (error) => {
        showErrorBar(
          enqueueSnackbar,
          `Could not fetch devices: ${error.message}`,
        );
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
        setLoading(false);
      },
    );
  };

  const pollPingTaskResult = (taskId, deviceIp, deviceId, attempt = 0) => {
    const maxAttempts = 15;

    void axiosConfig.perform_get(
      auth,
      `/v1/status/identify_device_result/?task_id=${encodeURIComponent(taskId)}`,
      (response) => {
        const data = response?.data ?? {};
        const state = data.state;

        if (state === 'SUCCESS') {
          showSuccessBar(
            enqueueSnackbar,
            `Successfully pinged device (${deviceIp})`,
          );
          void fetchDevices();
          return;
        }

        if (state === 'FAILURE') {
          showErrorBar(
            enqueueSnackbar,
            `Ping task failed for device (${deviceIp})`,
          );
          console.error('Ping task error:', data.error);
          return;
        }

        if (attempt + 1 >= maxAttempts) {
          showErrorBar(
            enqueueSnackbar,
            `Ping task timed out for device (${deviceIp})`,
          );
          return;
        }

        setTimeout(() => {
          pollPingTaskResult(taskId, deviceIp, deviceId, attempt + 1);
        }, 1000);
      },
      (error) => {
        showErrorBar(
          enqueueSnackbar,
          `Could not check ping result for device (${deviceIp})`,
        );
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
      },
    );
  };

  const handleIdentify = (ip, deviceId) => {
    if (!ip) {
      showErrorBar(enqueueSnackbar, 'Cannot ping device: missing IP');
      return;
    }

    void axiosConfig.perform_get(
      auth,
      `/v1/status/identify_device/?ip=${encodeURIComponent(ip)}`,
      (response) => {
        showSuccessBar(enqueueSnackbar, `Queued ping task for device (${ip})`);
        if (response?.data?.task_id) {
          pollPingTaskResult(response.data.task_id, ip, deviceId);
        }
      },
      (error) => {
        showErrorBar(
          enqueueSnackbar,
          `Could not queue ping for device (${ip})`,
        );
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
      },
    );
  };

  const handleRefresh = async (deviceId) => {
    setLoading(true);
    // Implement refresh logic - may need backend endpoint
    await fetchDevices();
  };

  const handleDelete = (deviceId: number) => {
    setDeleteTargetId(deviceId);
    setShow(
      (s) =>
        ({
          ...s,
          modalShowText: true,
          title: 'Delete Device',
          txt: 'Are you sure you want to delete this device?',
        }) as any,
    );
  };

  const doDelete = () => {
    if (deleteTargetId === null) return;
    setShow((s) => ({ ...s, modalShowText: false }) as any);
    setLoading(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/device/${deleteTargetId}/delete/`,
      () => {
        showSuccessBar(enqueueSnackbar, 'Device deleted successfully');
        setDevices((prev) =>
          prev.filter((d) => d.device.id !== deleteTargetId),
        );
        setDeleteTargetId(null);
      },
      (error) => {
        showErrorBar(
          enqueueSnackbar,
          `Could not delete device: ${error.message}`,
        );
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
        setDeleteTargetId(null);
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  useEffect(() => {
    if (!wsMessage) {
      return;
    }

    if (Array.isArray(wsMessage.devices)) {
      setDevices(wsMessage.devices);
      return;
    }

    const payload = wsMessage.data;
    if (payload && !Array.isArray(payload) && Array.isArray(payload.devices)) {
      setDevices(payload.devices);
      return;
    }

    if (Array.isArray(payload)) {
      setDevices(payload);
      return;
    }

    // For ping responses, update the matching device row
    if (wsMessage.type === 'identify_device_result' && wsMessage.ip) {
      setDevices((prev) =>
        prev.map((entry) =>
          entry.ip === wsMessage.ip
            ? { ...entry, online: Boolean(wsMessage.ok) }
            : entry,
        ),
      );
    }
  }, [wsMessage]);

  return (
    <Col>
      <div className="d-flex mb-4 justify-content-between align-items-center">
        <h1>Devices</h1>
        <Button
          variant="outline-primary"
          onClick={() => void fetchDevices()}
          disabled={loading}
        >
          {loading ? (
            <>
              <Spinner
                as="span"
                animation="border"
                size="sm"
                role="status"
                aria-hidden="true"
                className="me-2"
              />
              Loading...
            </>
          ) : (
            'Refresh All'
          )}
        </Button>
      </div>

      <ShowInfoModal callBackConfirm={doDelete} />

      {devices.length > 0 ? (
        <Row className="g-3">
          {devices.map((device) => (
            <Col key={device.device.id} lg={4} md={6} sm={12}>
              <DeviceCard
                device={device}
                onIdentify={handleIdentify}
                onDelete={handleDelete}
                loading={loading}
              />
            </Col>
          ))}
        </Row>
      ) : (
        <div className="text-center py-5">
          <p className="text-muted">No devices found</p>
        </div>
      )}
    </Col>
  );
};

export default DeviceListView;
