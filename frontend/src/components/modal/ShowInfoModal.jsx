import React, { useContext } from 'react';
import { Button, Form, Modal } from 'react-bootstrap';
import { CoreModalContext } from './coreModalContext';

import '../ui/css/CustomModal.css';

const ShowInfoModal = ({ callBackConfirm }) => {
  const [show, setShow] = useContext(CoreModalContext);
  const handleClose = () => {
    setShow((show) => ({ ...show, modalShowText: false }));
  };

  return (
    <Form>
      <Modal
        show={show.modalShowText}
        onHide={handleClose}
        dialogClassName={'wide-modal'}
      >
        <Modal.Header>
          <Modal.Title>{show.title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group controlId="formName">
            <Form.Label>{show.txt}</Form.Label>
          </Form.Group>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="secondary" onClick={handleClose}>
            Close
          </Button>
          {callBackConfirm !== undefined && (
            <Button variant="success" onClick={callBackConfirm}>
              Confirm
            </Button>
          )}
        </Modal.Footer>
      </Modal>
    </Form>
  );
};
export default ShowInfoModal;
