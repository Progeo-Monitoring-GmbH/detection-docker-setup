import { Button, Col } from 'react-bootstrap';
import React from 'react';
import { useAuth } from '../../../hooks/CoreAuthProvider';

const Navbar = ({}) => {
  const auth = useAuth();

  const logout = () => {
    auth.logoutAction();
  };

  const isAdmin = auth?.user?.is_superuser;

  return (
    <Col md={2} id={'v1-Navbar'}>
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

      <Button
        href="/project/overview/"
        variant="info"
        className="w-100 mt-2"
        size="lg"
      >
        Projects
      </Button>
      {isAdmin === 'true' && (
        <>
          <Button
            hreaf="/project/evaluate/"
            variant="info"
            className="w-100 mt-2"
            size="lg"
          >
            Evaluate
          </Button>
          <Button
            href="/project/backup/"
            variant="info"
            className="w-100 mt-2"
            size="lg"
          >
            Backup
          </Button>
          <Button
            href="/docker/"
            variant="info"
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
      )}
    </Col>
  );
};

export default Navbar;
