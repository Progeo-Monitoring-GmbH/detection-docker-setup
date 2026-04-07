import { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { standardFetchData } from '../helper';
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
                  `http://${device.ip}:80/ping/`,
                  (response) => {
                    showSuccessBar(enqueueSnackbar, `Successfully pinged device (${device.ip})`);
                    console.log('Ping response:', response.data);
                  },
                  (error) => {
                    showErrorBar(enqueueSnackbar, `Could not ping device (${device.ip})`);
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
