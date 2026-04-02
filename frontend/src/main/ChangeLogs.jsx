import React from 'react';
import { Col, Row } from 'react-bootstrap';
import BoxContainer from '../components/ui/BoxContainer';

const ChangeLogs = () => {
  // See https://dreamyguy.github.io/react-emojis/
  const logs = [
    {
      id: 1,
      date: '31.03.2026',
      version: '1.0.0',
      changes: [`Releasing stable version`],
    },
  ];

  return (
    <BoxContainer title={'ChangeLogs'}>
      {logs.map(({ id, date, version, changes }) => {
        return (
          <div key={`log-${id}`}>
            <Row className={'pt-3 pt-2'}>
              <Col md={2}>
                <h4>Version: {version}</h4>
              </Col>
              <Col md={2}>{date}</Col>
            </Row>
            <Row>
              <Col>
                <ul>
                  {changes.map((change, index) => {
                    return <li key={`li-change-${index}`}>{change}</li>;
                  })}
                </ul>
              </Col>
            </Row>
          </div>
        );
      })}
    </BoxContainer>
  );
};

export default ChangeLogs;
