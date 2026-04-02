import { Col, Row } from 'react-bootstrap';
import React from 'react';
import { prettyAmount } from '../../helper';
import BoxContainer from './BoxContainer';

const SummaryContainer = ({ summary }) => {
  return summary ? (
    <BoxContainer title={'Summary'}>
      <Row>
        <Col md={2}>
          Einnahmen:
          <br />
          <br />
          Ausgaben:
          <br />
          <br />
          Aktueller Stand:
          <br />
          <br />
        </Col>
        <Col>
          {prettyAmount(summary['in'])}
          <br />
          {prettyAmount(summary['out'])}
          <br />
          {prettyAmount(summary['total'])}
          <br />
        </Col>
      </Row>
    </BoxContainer>
  ) : (
    <></>
  );
};

export default SummaryContainer;
