import { Button } from 'react-bootstrap';
import React from 'react';
import * as actionTypes from '../reducer/reducerTypes';

const AddSplitButtons = ({ balance, state, dispatch }) => {
  const handleAddDiff = (balance) => {
    let data = state.splits;
    let i = data.length - 1;
    data[i] = { ...data[i], amount: balance, raw: balance };
    dispatch({ type: actionTypes.SET_SPLITS, payload: data });
  };

  if (balance === 0) {
    return <Button variant={'success'}>Balanced</Button>;
  }

  return (
    <Button onClick={() => handleAddDiff(balance)}>
      Current Diff: {balance}
    </Button>
  );
};

export default AddSplitButtons;
