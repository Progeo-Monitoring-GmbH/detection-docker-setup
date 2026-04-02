import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import axiosConfig from '../axiosConfig';
import LoadingIcon from '../components/ui/LoadingIcon';
import { Row, Col } from 'react-bootstrap';
import { useAuth } from '../../hooks/CoreAuthProvider';

const TokenTransit = () => {
  const queryParameters = new URLSearchParams(window.location.search);
  const forward = queryParameters.get('forward');
  const token = queryParameters.get('token');

  const { account, modal, id } = useParams();
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setError] = useState(false);
  const [data, setData] = useState(null);
  const auth = useAuth();

  async function fetchData() {
    await axiosConfig.perform_post(
      auth,
      `/v1/${account}/qrcode/verify/`,
      {
        token: token,
      },
      (response) => {
        setIsLoading(false);
        if (response.data.success) {
          setData(response.data);
        }
      },
      (error) => {
        setIsLoading(false);
        setError(true);
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
      },
      { headers: { Authorization: `Token ${token}` } },
    );
  }

  useEffect(() => {
    if (token) {
      fetchData();
    }
  }, [token]);

  if (isLoading) {
    return (
      <Row>
        <LoadingIcon />
      </Row>
    );
  }
  if (hasError) {
    return (
      <Row>
        <Col>
          <h2 className={'text-danger'}>Nothing to see here...</h2>
        </Col>
      </Row>
    );
  }

  if (!data) {
    return (
      <Row>
        <Col>
          <h2 className={'text-danger'}>Not available anymore...</h2>
        </Col>
      </Row>
    );
  } else {
    let url = id
      ? `/main/${account}/veri/${modal}/${id}/verified/${forward}/${token}`
      : `/main/${account}/veri/${modal}/verified/${forward}/${token}`;

    auth.navigate(url, { headers: { Authorization: `Token ${token}` } });
  }
};
export default TokenTransit;
