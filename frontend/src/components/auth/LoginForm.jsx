import React, { useState } from 'react';
import { Button, Col, Container, Form, InputGroup, Row } from 'react-bootstrap';
import { Link, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { Eye, EyeSlash } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { PRIVACY_POLICY_URL } from '../privacy/consent';

const LoginForm = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { enqueueSnackbar } = useSnackbar();
  const { register, handleSubmit } = useForm();
  const [showPasswd, setShowPasswd] = useState(false);
  const auth = useAuth();
  const { t } = useTranslation();

  const onSubmit = async (data) => {
    const forward = searchParams.get('forward') || '/v1/0/overview';
    await auth.loginAction(data, forward);
  };

  return (
    <Container>
      <Row
        md={4}
        className="justify-content-md-center"
        style={{ marginTop: 60 }}
      >
        <Col xs={6}>
          <Form onSubmit={handleSubmit(onSubmit)}>
            <Form.Group controlId="formUser">
              <Form.Label>Username</Form.Label>
              <Form.Control
                type="text"
                placeholder="Enter User"
                {...register('username')}
              />
            </Form.Group>

            <Form.Group controlId="formPassword" className={'mt-4'}>
              <Form.Label>Password</Form.Label>
              <InputGroup>
                <Form.Control
                  type={showPasswd ? 'text' : 'password'}
                  placeholder="Password"
                  {...register('password')}
                />
                <InputGroup.Text>
                  {showPasswd ? (
                    <EyeSlash onClick={() => setShowPasswd(!showPasswd)} />
                  ) : (
                    <Eye onClick={() => setShowPasswd(!showPasswd)} />
                  )}
                </InputGroup.Text>
              </InputGroup>
            </Form.Group>

            <Button variant="primary" type="submit" className={'mt-5'}>
              Login
            </Button>
          </Form>
          <div className="mt-4 small">
            <Link to={PRIVACY_POLICY_URL}>{t('consent_privacy_policy')}</Link>
          </div>
        </Col>
      </Row>
    </Container>
  );
};
export default LoginForm;
