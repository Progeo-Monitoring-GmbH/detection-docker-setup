import { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { defaultErrorCallback, standardFetchData } from '../helper';
import { Button, Col, Row } from 'react-bootstrap';
import axiosConfig from '../axiosConfig';

type DeviceInfo = {
  mac: string;
  ip: string;
  hostname: string;
};

const DemoView = () => {
  const auth = useAuth();
  const [data, setData] = useState<DeviceInfo[]>([]);

  useEffect(() => {
    standardFetchData(auth, `/v1/status/list_connected/`, setData);
  }, []);

  return (
    <div>
      This is a simple demo to get and test connected devices<br />
      {data.map((device, index) => (
        <Row key={index}>
          <Col>{device.mac} - {device.ip} - {device.hostname}</Col>
          <Col>
            <Button
              variant="success"
              onClick={() => {
                void axiosConfig.perform_get(
                  auth,
                  `http://${device.ip}:80/ping`,
                  (response) => {
                    console.log('Ping response:', response.data);
                  },
                  defaultErrorCallback,
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
