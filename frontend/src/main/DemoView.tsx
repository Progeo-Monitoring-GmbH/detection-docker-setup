import { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { Button, Col, Row } from 'react-bootstrap';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';

type DeviceInfo = {
  mac: string;
  ip: string;
  hostname: string;
};


const DemoView = () => {
  const auth = useAuth();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const { enqueueSnackbar } = useSnackbar();

  function pollPingTaskResult(taskId: string, deviceIp: string, attempt = 0) {
    const maxAttempts = 15;

    void axiosConfig.perform_get(
      auth,
      `/v1/status/ping_device_result/?task_id=${encodeURIComponent(taskId)}`,
      (response) => {
        const data = response?.data ?? {};
        const state = data.state;

        if (state === 'SUCCESS') {
          showSuccessBar(enqueueSnackbar, `Successfully pinged device (${deviceIp})`);
          console.log('Ping task result:', data.result);
          return;
        }

        if (state === 'FAILURE') {
          showErrorBar(enqueueSnackbar, `Ping task failed for device (${deviceIp})`);
          console.error('Ping task error:', data.error);
          return;
        }

        if (attempt + 1 >= maxAttempts) {
          showErrorBar(enqueueSnackbar, `Ping task timed out for device (${deviceIp})`);
          return;
        }

        setTimeout(() => {
          pollPingTaskResult(taskId, deviceIp, attempt + 1);
        }, 1000);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, `Could not check ping result for device (${deviceIp})`);
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
      },
    );
  }

  async function fetchDevices(
    auth,
    url,
    setter,
    header = {},
  ) {
    return await axiosConfig.perform_get(
      auth,
      url,
      (response) => {
        setter(response.data.devices);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, `Could not fetch devices: ${error.message}`);
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
      },
      header,
    );
  }

  useEffect(() => {
    fetchDevices(auth, `/v1/status/list_connected/`, setDevices);
  }, []);

  return (
    <div>
      <h3>This is a simple demo to get and test connected devices</h3>
      <br /><br />

      {devices.length === 0 && <p>No devices found.</p>}
      
      {devices.map((device, index) => (
        <Row key={index} className="py-1">
          <Col>{device.mac} - {device.ip} - {device.hostname}</Col>
          <Col>
            <Button
              variant="success"
              onClick={() => {
                void axiosConfig.perform_get(
                  auth,
                  `/v1/status/ping_device/?ip=${encodeURIComponent(device.ip)}`,
                  (response) => {
                    showSuccessBar(enqueueSnackbar, `Queued ping task for device (${device.ip})`);
                    console.log('Ping task queued:', response.data);
                    if (response?.data?.task_id) {
                      pollPingTaskResult(response.data.task_id, device.ip);
                    }
                  },
                  (error) => {
                    showErrorBar(enqueueSnackbar, `Could not queue ping for device (${device.ip})`);
                    if (error.response) {
                      console.error(error.response.data);
                    } else {
                      console.error(error);
                    }
                  },
                );
              }}
            >
              Ping
            </Button>
          </Col>
        </Row>
      ))}
    </div>
  );
};

export default DemoView;
