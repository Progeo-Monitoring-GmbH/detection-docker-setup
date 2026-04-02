import { Offcanvas } from 'react-bootstrap';
import React, { useState } from 'react';

const CoreOffCanvas = ({ name, placement, active = false, ...props }) => {
  const [show, setShow] = useState(active);

  const handleClose = () => setShow(false);
  const handleShow = () => setShow(true);

  return (
    <Offcanvas
      show={show}
      onHide={handleClose}
      placement={placement}
      {...props}
    >
      <Offcanvas.Header closeButton>
        <Offcanvas.Title>Offcanvas</Offcanvas.Title>
      </Offcanvas.Header>
      <Offcanvas.Body>
        Some text as placeholder. In real life you can have the elements you
        have chosen. Like, text, images, lists, etc.
      </Offcanvas.Body>
    </Offcanvas>
  );
};

export default CoreOffCanvas;
