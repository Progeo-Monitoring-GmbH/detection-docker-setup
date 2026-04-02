import { Button, Col, Row } from 'react-bootstrap';
import React, { useState } from 'react';
import { Typeahead } from 'react-bootstrap-typeahead';
import BoxContainer from './BoxContainer';
import { capitalizeFirstLetter } from '../../helper';

const ChooserBoxContainer = ({
  title,
  current,
  data,
  filtr = () => {},
  callBack = () => {},
}) => {
  const initName = data.find((obj) => obj.id === parseInt(current))?.name;

  const [selected, setSelected] = useState(initName ? [initName] : []);

  const changeElement = (option) => {
    let elements = data.map((obj) => obj.name);
    let _index = elements.indexOf(option[0]);
    callBack(data[_index]);
    setSelected(option);
  };

  const selectChooser = (diff) => {
    let elements = data.map((obj) => obj.name);
    let _index = elements.indexOf(selected[0]) + diff;
    let element = elements.slice(_index, _index + 1);
    callBack(data[_index]);
    setSelected(element);
  };

  const selectChooserStartOrEnd = (isLast) => {
    let elements = data.map((obj) => obj.name);
    let element, _index;
    if (isLast) {
      element = elements.slice(-1);
      _index = elements.length - 1;
    } else {
      element = elements.slice(0, 1);
      _index = 0;
    }
    callBack(data[_index]);
    setSelected(element);
  };

  const filteredData = data
    .filter(filtr)
    .map((obj) => obj.name)
    .sort();

  return (
    <BoxContainer title={`Select ${capitalizeFirstLetter(title)}`}>
      <Row>
        <Col md={1} style={{ minWidth: 120 }}>
          <Button
            onClick={() => selectChooserStartOrEnd(false)}
            className={'me-2'}
          >
            <i className="bi bi-rewind-fill" />
          </Button>
          <Button onClick={() => selectChooser(-1)}>
            <i className="bi bi-caret-left-fill" />
          </Button>
        </Col>
        <Col md={4}>
          {selected && (
            <Typeahead
              id={`${title}-chooser`}
              labelKey="name"
              onChange={(opt) => changeElement(opt)}
              options={filteredData}
              placeholder={`Choose a ${title}...`}
              selected={selected}
              defaultSelected={selected}
              clearButton={true}
              theme="dark"
            />
          )}
        </Col>
        <Col md={1} style={{ minWidth: 120 }}>
          <Button onClick={() => selectChooser(+1)} className={'me-2'}>
            <i className="bi bi-caret-right-fill" />
          </Button>
          <Button onClick={() => selectChooserStartOrEnd(true)}>
            <i className="bi bi-fast-forward-fill" />
          </Button>
        </Col>
      </Row>
    </BoxContainer>
  );
};
export default ChooserBoxContainer;
