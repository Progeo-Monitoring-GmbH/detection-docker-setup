import React from 'react';
import { Navigate, useParams } from 'react-router';

const TokenLogin = ({ forward }) => {
  const { account, modal, id, token } = useParams();
  let url = id
    ? `/main/${account}/anon/${modal}/${id}/transit/?forward=${forward}&token=${token}`
    : `/main/${account}/anon/${modal}/transit/?forward=${forward}&token=${token}`;

  return <Navigate to={url} />;
};
export default TokenLogin;
