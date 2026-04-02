import React from 'react';
import styled from 'styled-components';
import { Button } from 'react-bootstrap';
import '../ui/css/FilterComponent.css';

const TextField = styled.input`
  height: 36px;
  width: 200px;
  border-radius: 3px;
  border-top-left-radius: 5px;
  border-bottom-left-radius: 5px;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border: 1px solid #e5e5e5;
  padding: 0 32px 0 16px;
  font-size: 15px;
`;

export const FilterComponent = ({
  filterText,
  onFilter,
  onClear,
  filterComponentStyle,
}) => (
  <div style={filterComponentStyle}>
    <TextField
      id="search"
      type="text"
      placeholder="Filter by..."
      aria-label="Search Input"
      value={filterText}
      onChange={onFilter}
    />
    <Button variant={'danger'} className={'filterButton'} onClick={onClear}>
      X
    </Button>
  </div>
);
