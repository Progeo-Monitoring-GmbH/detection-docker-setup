import { Button, Col, Form, Row } from 'react-bootstrap';
import React from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '../../../hooks/CoreAuthProvider.js';
import axiosConfig from '@/axiosConfig.js';
import { defaultErrorCallback } from '@/helper.jsx';

const SimpleInputForm = ({
  url,
  available,
  fieldname,
  callBackInput = (response) => {},
}) => {
  const { register, handleSubmit } = useForm();
  const auth = useAuth();

  const onSubmit = async (data) => {
    axiosConfig.perform_post(
      auth,
      url,
      {
        ...data,
      },
      (response) => {
        if (response.data.success) {
          console.log(response);
          callBackInput(response.data);
        }
      },
      defaultErrorCallback,
    );
  };

  return (
    <Form onSubmit={handleSubmit(onSubmit)}>
      <Row className={'mb-3'}>
        <Col md={2}>
          <select
            {...register('selectedZip', { required: true })}
            defaultValue=""
          >
            <option value="" disabled>
              -- Select a ZIP file --
            </option>
            {available.map((filename) => (
              <option key={filename} value={filename}>
                {filename}
              </option>
            ))}
          </select>
        </Col>
        <Col md={2}>
          <Form.Control
            type="password"
            placeholder={`Enter ${fieldname}`}
            {...register(fieldname)}
          />
        </Col>
        <Col>
          <Button variant="primary" type="submit">
            Send
          </Button>
        </Col>
      </Row>
    </Form>
  );
};
export default SimpleInputForm;
