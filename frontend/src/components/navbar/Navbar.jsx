import { Button, Col } from 'react-bootstrap';
import React from 'react';
import { useAuth } from '../../../hooks/CoreAuthProvider';

const Navbar = ({ act, content }) => {
  const auth = useAuth();

  const logout = () => {
    auth.logoutAction();
  };

  const isAdmin = auth?.user?.is_superuser;

  return (
    <>
      <Col md={2} id={'v1-Navbar'}>
        <Button
          href="/device/overview/"
          variant={act === 'device' ? 'info' : 'secondary'}
          className="w-100 mt-2"
          size="lg"
        >
          Devices
        </Button>

        <Button
          href="/device/measure/"
          variant={act === 'measure' ? 'info' : 'secondary'}
          className="w-100 mt-2"
          size="lg"
        >
          Measurements
        </Button>
        {isAdmin === 'true' ||
          (true && (
            <>
              <Button
                href="/backup/1/overview/"
                variant={act === 'backup' ? 'info' : 'secondary'}
                className="w-100 mt-2"
                size="lg"
              >
                Backup
              </Button>
              <Button
                href="/docker/"
                variant={act === 'docker' ? 'info' : 'secondary'}
                className="w-100 mt-2"
                size="lg"
              >
                Docker Status
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
          ))}
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
