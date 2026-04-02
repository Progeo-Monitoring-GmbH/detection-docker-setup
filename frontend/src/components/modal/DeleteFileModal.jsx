import React, { useContext } from 'react';
import { Button, Modal } from 'react-bootstrap';
import { CoreModalContext } from './coreModalContext';
import axiosConfig from '../../axiosConfig';
import { showErrorBar, showSuccessBar } from '../ui/Snackbar';
import { useSnackbar } from 'notistack';
import { defaultErrorCallback } from '@/helper.jsx';

const DeleteFileModal = ({ account, callBackDeleteFile }) => {
  const [show, setShow] = useContext(CoreModalContext);
  const { enqueueSnackbar } = useSnackbar();

  const onSubmit = () => {
    axiosConfig.holder
      .delete(`/streaming/api/media/${show.type}/${show.id}/`) //TODO outdated
      .then((response) => {
        console.log('DELETION', response);
        callBackDeleteFile({ type: show.type });
        if (response.status === 204) {
          showSuccessBar(enqueueSnackbar, 'Successfully deleted file!');
        } else {
          showErrorBar(enqueueSnackbar, 'Deletion failed!');
        }
        handleClose();
      }, defaultErrorCallback);
  };

  const handleClose = () => {
    setShow((show) => ({ ...show, modalDeleteFile: false }));
  };

  const prettyTitle = () => {
    if (show.type === 'images') {
      return 'Image';
    } else if (show.type === 'videos') {
      return 'Video';
    }
    return 'Unhandled!';
  };

  return (
    <Modal show={show.modalDeleteFile} onHide={handleClose}>
      <Modal.Header>
        <Modal.Title>Delete {prettyTitle()}</Modal.Title>
      </Modal.Header>
      <Modal.Body>You want to delete the selected {prettyTitle()}?</Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleClose}>
          Close
        </Button>
        <Button variant="danger" onClick={onSubmit}>
          Delete
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default DeleteFileModal;
