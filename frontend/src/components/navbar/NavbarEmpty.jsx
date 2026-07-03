import { Col } from 'react-bootstrap';
import React from 'react';
import { useAuth } from '../../../hooks/CoreAuthProvider';

const Navbar = ({ act, content }) => {
  const auth = useAuth();

  const logout = () => {
    auth.logoutAction();
  };

  return (
    <>
      <Col md={2} id={'v1-Navbar'}></Col>
      <Col md={10} className={`ps-3`}>
        {content}
      </Col>
    </>
  );
};

export default Navbar;
