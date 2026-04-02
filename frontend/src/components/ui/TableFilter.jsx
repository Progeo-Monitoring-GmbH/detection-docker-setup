import React, { useState } from 'react';
import { FilterComponent } from './FilterComponent';
import { applyFilter } from './MultiselectButton';
import { getDeepKeyFromObject } from '../../helper';

export function usePureTableFilter(_fields) {
  return useTableFilter(undefined, () => {}, {}, _fields);
}

export function useTableFilter(
  resetPagination = undefined,
  setResetPagination = () => {},
  filterComponentStyle = { position: 'relative', top: -50 },
  _fields = ['date', 'recipient_name', 'reference', 'amount'],
) {
  const [filterText, setFilterText] = useState('');

  const checkFilter = (row, _field) => {
    if (filterText.length === 0) {
      return true;
    }
    const value = getDeepKeyFromObject(row, _field);
    if (value) {
      switch (typeof value) {
        case 'string':
          return value.toLowerCase().includes(filterText.toLowerCase());
        case 'number':
          return value.toString().includes(filterText.toLowerCase());
        default:
          console.log(value, '=>', typeof value);
      }
    }
    return false;
  };

  function updateFilteredData(bookings, filter = {}) {
    return bookings
      ? applyFilter(
          bookings.filter((row) => _fields.some((f) => checkFilter(row, f))),
          filter,
        )
      : [];
  }

  const handleClear = () => {
    if (filterText) {
      setResetPagination(!resetPagination);
      setFilterText('');
    }
  };

  const filterMemo = React.useMemo(() => {
    return (
      <>
        <FilterComponent
          onFilter={(e) => setFilterText(e.target.value)}
          onClear={handleClear}
          filterText={filterText}
          filterComponentStyle={filterComponentStyle}
        />
      </>
    );
  }, [filterText, resetPagination]);

  return { filterMemo, filterText, updateFilteredData };
}
