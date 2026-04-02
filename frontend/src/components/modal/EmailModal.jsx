import React, { useContext, useEffect, useReducer } from 'react';
import { Button, Form, Modal } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import axiosConfig from '../../axiosConfig';
import * as actionTypes from '../reducer/reducerTypes';
import { CoreModalContext } from './coreModalContext';
import {
  defaultStateTemplate,
  reducerTemplate,
} from '../reducer/reducerTemplate';
import { defaultErrorCallback, SelectListened } from '../../helper';
import { useAuth } from '../../../hooks/CoreAuthProvider';

const EmailModal = ({ account, callBackData }) => {
  const { handleSubmit } = useForm();

  const [show, setShow] = useContext(CoreModalContext);
  const [state, dispatch] = useReducer(reducerTemplate, defaultStateTemplate);
  const auth = useAuth();
  async function fetchAttachments() {
    console.log('fetchAttachments()');
    await axiosConfig.perform_post(
      auth,
      `/v1/${account}/contract/attachments/`,
      {
        ids: show.ids,
      },
      (response) => {
        console.log(response.data);
        if (response.data.success) {
          response.data.attachments.unshift('---');
          dispatch({
            type: actionTypes.SET_AVAIL_ATTACHMENTS,
            payload: response.data.attachments,
          });
        }
      },
      defaultErrorCallback,
    );
  }

  useEffect(() => {
    show.modalEmail && fetchAttachments();
  }, [show.modalEmail]);

  const onSubmit = () => {
    console.log(state);
    axiosConfig.perform_post(
      auth,
      `/v1/${account}/contract/send-mail/`,
      {
        ...state,
        ids: show.ids,
      },
      (response) => {
        console.log(response);
        callBackData(response.data);
        // handleClose(); TODO
      },
      defaultErrorCallback,
    );
  };

  const handleClose = () => {
    dispatch({ type: actionTypes.SET_RESET });
    setShow((show) => ({ ...show, modalEmail: false }));
  };

  function isDisabledYet() {
    return state.mailSubject === '' || state.mailContent === '';
  }

  return (
    <Form>
      <Modal show={show.modalEmail} onHide={handleClose}>
        <Modal.Header>
          <Modal.Title>EMail-Template Creator</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group controlId="formValue">
            <Form.Label className={'mt-2'}>Subject</Form.Label>
            <Form.Control
              as="textarea"
              rows={2}
              placeholder="Mails-Subject"
              onChange={(e) => {
                dispatch({
                  type: actionTypes.SET_MAIL_SUBJECT,
                  payload: e.target.value,
                });
              }}
              value={state.mailSubject}
            />
          </Form.Group>
          <Form.Group controlId="formValue">
            <Form.Label className={'mt-2'}>Content</Form.Label>
            <Form.Control
              as="textarea"
              rows={5}
              placeholder="Text-Body"
              onChange={(e) => {
                dispatch({
                  type: actionTypes.SET_MAIL_CONTENT,
                  payload: e.target.value,
                });
              }}
              value={state.mailContent}
            />
          </Form.Group>
          <Form.Group controlId="formValue">
            <Form.Label>Add Attachment</Form.Label>
            <SelectListened
              name="tag"
              options={state.availableAttachments}
              onChange={(e) => {
                let field = e.target.value;
                let name = state.availableAttachments[field];
                dispatch({ type: actionTypes.ADD_FILE, payload: name });
              }}
            />
          </Form.Group>
          <Form.Group controlId="formValue">
            {state.selectedAttachments.map((attachment) => {
              return (
                <>
                  {attachment}
                  <Button
                    className="ms-1"
                    onClick={() =>
                      dispatch({
                        type: actionTypes.REMOVE_FILE,
                        payload: attachment,
                      })
                    }
                  >
                    <i className=" bi bi-trash px-0" />
                  </Button>
                </>
              );
            })}
          </Form.Group>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="danger" onClick={handleClose}>
            Abort
          </Button>
          <Button
            variant="success"
            onClick={handleSubmit(onSubmit)}
            disabled={isDisabledYet()}
          >
            Send Mails
          </Button>
        </Modal.Footer>
      </Modal>
    </Form>
  );
};

export default EmailModal;
