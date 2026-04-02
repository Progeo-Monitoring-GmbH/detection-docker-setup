import { Accordion } from 'react-bootstrap';
import React from 'react';

import './css/AccordionContainer.css';

const AccordionContainer = ({ title, children, style = {}, eventKey = 0 }) => {
  return (
    <Accordion
      className="col-* mt-3 mb-5"
      style={{ padding: 0 }}
      defaultActiveKey={0}
    >
      <Accordion.Item eventKey={eventKey}>
        <Accordion.Header>{title}</Accordion.Header>
        <Accordion.Body as="div" style={style}>
          {children}
        </Accordion.Body>
      </Accordion.Item>
    </Accordion>
  );
};

export default AccordionContainer;
