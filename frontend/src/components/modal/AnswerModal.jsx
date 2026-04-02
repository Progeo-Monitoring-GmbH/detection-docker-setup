import React, { useContext } from 'react';
import { Button, Form, Modal } from 'react-bootstrap';
import { CoreModalContext } from './coreModalContext';
import { configTextNeeded } from '../form/config';
import { useForm } from 'react-hook-form';
import axiosConfig from '../../axiosConfig';
import '../ui/css/CustomModal.css';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { defaultErrorCallback } from '@/helper.jsx';

const AnswerModal = ({ callBackAnswer }) => {
  const [show, setShow] = useContext(CoreModalContext);
  const {
    register,
    setError,
    formState: { errors },
    handleSubmit,
    reset,
  } = useForm();

  const auth = useAuth();
  const handleClose = () => {
    reset({ answer: '' });
    setShow((show) => ({ ...show, modalAnswer: false }));
  };

  // useEffect(() => {}, [show]);

  const onSubmit = (data) => {
    axiosConfig.perform_post(
      auth,
      `/api/toolz/hiddenchallenge/${show.id}/answer/`,
      {
        ...data,
      },
      (response) => {
        if (response.data.success) {
          if (response.data.answered_correctly) {
            callBackAnswer(response.data);
            handleClose();
          } else {
            if (response.data.simularity <= 50) {
              reset({ answer: '' });
            } else {
              // TODO
            }
            setError('answer', {
              type: 'manual',
              message: 'Nah! That was wrong!',
            });
          }
        }
      },
      defaultErrorCallback,
    );
  };

  function isDisabledYet() {
    return false;
  }

  return (
    <Form>
      <Modal
        show={show.modalAnswer}
        onHide={handleClose}
        dialogClassName={'wide-modal'}
      >
        <Modal.Header>
          <Modal.Title>{show.question}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Group controlId="formFieldName" className={'my-2'}>
            <Form.Label>
              Antwort
              <div className={'modalErrors'}>
                {errors.answer?.type === 'required' && errors.answer?.message}
                {errors.answer?.type === 'minLength' && errors.answer?.message}
                {errors.answer?.type === 'manual' && errors.answer?.message}
              </div>
            </Form.Label>
            <Form.Control
              as="textarea"
              rows={5}
              placeholder="Easy! The correct answer is..."
              {...register('answer', configTextNeeded)}
            />
          </Form.Group>
        </Modal.Body>

        <Modal.Footer>
          <Button
            variant="success"
            onClick={handleSubmit(onSubmit)}
            disabled={isDisabledYet()}
          >
            Lock answer!
          </Button>
          <Button variant="secondary" onClick={handleClose}>
            Close
          </Button>
        </Modal.Footer>
      </Modal>
    </Form>
  );
};

export default AnswerModal;
