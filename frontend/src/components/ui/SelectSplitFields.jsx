import React, { useState } from 'react';
import { Button, Form } from 'react-bootstrap';
import { Typeahead } from 'react-bootstrap-typeahead';
import * as actionTypes from '../reducer/reducerTypes';

export const SelectSplitFields = ({
  options,
  dispatch,
  raw,
  initData,
  initUpdate = 0,
  with_reference = true,
}) => {
  const [data, setData] = useState(initData);
  const [update, setUpdate] = useState(initUpdate);

  function handleSplit(i, value) {
    if (value) {
      console.log('handleSplit', i, value);
      data[i] = { ...data[i], name: value };
      setData(data);
      dispatch({ type: actionTypes.SET_SPLITS, payload: data });
    }
  }

  function handleAmount(i, str) {
    let value;
    if (str.includes('*d*')) {
      let start = str.indexOf('*d*');
      let search = str.substring(0, start - 1);
      let left_cut = raw.substring(raw.indexOf(search) + start);
      value = left_cut.substring(0, left_cut.indexOf(' ')).replaceAll(',', '.');
    } else {
      str = str.replace(',', '.');
      if (str.slice(-1) === '.') {
        value = parseFloat(str);
      } else {
        value = parseFloat(str);
      }
    }
    data[i] = { ...data[i], amount: value, raw: str };
    setData(data);
    dispatch({ type: actionTypes.SET_SPLITS, payload: data });
  }

  function appendSplit() {
    let _id = data.length;
    data.push({ id: _id });
    setData(data);
    dispatch({ type: actionTypes.SET_SPLITS, payload: data });
    setUpdate(new Date().getTime());
  }

  function removeSplit() {
    data.pop();
    setData(data);
    dispatch({ type: actionTypes.SET_SPLITS, payload: data });
    setUpdate(new Date().getTime());
  }

  function getSplits() {
    let splits = [];
    data.map(({ id, name, raw }) => {
      splits.push(
        <div key={`splitHolder-${id}`}>
          <Form.Group className={'pt-3'} controlId="formFieldSplit">
            Split #{id + 1}
          </Form.Group>

          <Form.Group controlId="formFieldTag">
            <Typeahead
              id="tag-chooser"
              labelKey="name"
              onChange={(e) => handleSplit(id, e[0])}
              options={options}
              placeholder="Choose a tag..."
              clearButton={true}
              theme="dark"
            />

            <Form.Control
              type="text"
              className={'input-form'}
              value={raw || ''}
              placeholder="Enter Amount or Pattern..."
              onChange={(e) => handleAmount(id, e.target.value)}
            />
          </Form.Group>
        </div>,
      );
    });

    return splits;
  }

  return (
    <>
      {with_reference && (
        <>
          Reference:
          <Form.Control as="textarea" rows={5} disabled={true} value={raw} />
        </>
      )}

      {getSplits()}

      <Form.Group controlId="formField">
        <Button
          className={'btn-sm me-2 my-2'}
          variant={'success'}
          onClick={() => appendSplit()}
        >
          +
        </Button>
        <Button
          className={'btn-sm me-2 my-2'}
          variant={'danger'}
          onClick={() => removeSplit()}
        >
          -
        </Button>
      </Form.Group>
    </>
  );
};
