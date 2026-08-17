import React from 'react';
import { Button, Col } from 'react-bootstrap';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import usePermissions from '../../../hooks/usePermissions';

const Navbar = ({ act, content }) => {
  const auth = useAuth();
  const { hasPermission } = usePermissions();

  const logout = () => {
    auth.logoutAction();
  };

  return (
    <>
      <Col md={2} id={'v1-Navbar'}>
        {hasPermission('module_devices_enabled') && (
          <Button
            href="/device/overview/"
            variant={act === 'device' ? 'info' : 'secondary'}
            className="w-100 mt-2"
            size="lg"
          >
            Devices
          </Button>
        )}

        {hasPermission('module_locations_enabled') && (
          <Button
            href="/location/overview/"
            variant={act === 'location' ? 'info' : 'secondary'}
            className="w-100 mt-2"
            size="lg"
          >
            Locations
          </Button>
        )}

        {hasPermission('module_measurements_enabled') && (
          <Button
            href="/device/measure/"
            variant={act === 'measure' ? 'info' : 'secondary'}
            className="w-100 mt-2"
            size="lg"
          >
            Measurements
          </Button>
        )}
        {hasPermission('module_measurements_enabled') && (
          <Button
            href="/alarms/"
            variant={act === 'alarms' ? 'info' : 'secondary'}
            className="w-100 mt-2"
            size="lg"
          >
            Alarms
          </Button>
        )}
        {hasPermission('module_imei_enabled') && (
          <Button
            href="/devices/imei/display/"
            variant={act === 'imei' ? 'info' : 'secondary'}
            className="w-100 mt-2"
            size="lg"
          >
            IMEI Display
          </Button>
        )}
        {hasPermission('module_backup_enabled') && (
          <>
            <Button
              href="/backup/1/overview/"
              variant={act === 'backup' ? 'info' : 'secondary'}
              className="w-100 mt-2"
              size="lg"
            >
              Backup
            </Button>
          </>
        )}
        {hasPermission('module_docker_enabled') && (
          <Button
            href="/docker/"
            variant={act === 'docker' ? 'info' : 'secondary'}
            className="w-100 mt-2"
            size="lg"
          >
            Docker Status
          </Button>
        )}
        {hasPermission('module_admin_enabled') && (
          <>
            <Button
              href="/admin/panel/"
              variant={act === 'adminpanel' ? 'info' : 'secondary'}
              className="w-100 mt-2"
              size="lg"
            >
              Admin Panel
            </Button>
            <Button
              href={`${import.meta.env.VITE_BACKEND_URL}/aadmin`}
              variant="primary"
              className="w-100 mt-2"
              size="lg"
            >
              Admin
            </Button>
          </>
        )}
        <Button
          variant="primary"
          className="w-100 mt-2"
          size="lg"
          onClick={() => {
            logout();
          }}
        >
          Logout
        </Button>
      </Col>
      <Col md={10} className={`ps-3`}>
        {content}
      </Col>
    </>
  );
};

export default Navbar;
