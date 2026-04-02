import { Row } from 'react-bootstrap';
import LoadingIcon from './LoadingIcon.jsx';
import React from 'react';

const LoadAble = ({ loaded, children }) => {
  if (!loaded) {
    return (
      <Row>
        <LoadingIcon />
      </Row>
    );
  }
  return children;
};
export default LoadAble;
