import React, { useEffect, useState } from 'react';
import { Col } from 'react-bootstrap';
import Form from 'react-bootstrap/Form';

const MultiselectButton = ({
  filter,
  setFilter,
  name,
  targetField,
  comparator,
  data,
  width = 6,
  variant = 'button',
  soloSelection = false,
  hasClearButton = true,
  autoSelect = '',
}) => {
  const [selected, setSelected] = useState([]);
  const obj = {};
  obj[name] = { target: targetField, comparator: comparator, values: [] };

  useEffect(() => {
    if (autoSelect) {
      onCheck(autoSelect);
    }
  }, []);

  function onCheck(value) {
    let list = Object.values(selected);

    if (soloSelection) {
      list = list.includes(value) ? [] : [value];
    } else {
      if (list.includes(value)) {
        list = list.filter((item) => item !== value);
      } else {
        list.push(value);
      }
    }

    if (list.length > 0) {
      obj[name]['values'] = list;
      setSelected(list);
      setFilter({ ...filter, ...obj });
    } else {
      clearSelection();
    }
  }

  function clearSelection() {
    delete filter[name];
    setSelected([]);
    setFilter({ ...filter });
  }

  if (data.length < 1 || data[0] === null) {
    // console.log(`[INFO] MultiselectButton '${name}' hidden`);
    return <></>;
  }

  return (
    <Col key={name} md={width}>
      <span className={'pe-4'}>
        {name[0].toUpperCase() + name.substring(1)}:
      </span>

      {data.map((item) => {
        if (item) {
          switch (variant) {
            case 'button':
              if (selected.includes(item)) {
                return (
                  <button
                    key={item}
                    type="button"
                    className="btn btn-info me-1"
                    onClick={() => onCheck(item)}
                  >
                    {item}
                  </button>
                );
              } else {
                return (
                  <button
                    key={item}
                    type="button"
                    className="btn btn-outline-info me-1"
                    onClick={() => onCheck(item)}
                  >
                    {item}
                  </button>
                );
              }

            case 'checkbox':
              return (
                <Form.Check
                  key={item}
                  type={'checkbox'}
                  label={item}
                  onChange={() => onCheck(item)}
                />
              );
          }
        }
      })}

      {selected.length && hasClearButton ? (
        <button
          type="button"
          className="btn btn-outline-danger"
          onClick={clearSelection}
        >
          X
        </button>
      ) : (
        ''
      )}
    </Col>
  );
};

export default MultiselectButton;

// ===============================================================================================

export function applyFilter(baseFilter, filter) {
  return baseFilter.filter(function (obj) {
    let results = [];
    let result;

    for (const value of Object.values(filter)) {
      result = false;
      switch (value['comparator']) {
        case 'is':
        case 'contains':
          results.push(value['values'].includes(obj[value['target']]));
          break;

        case 'startsWith':
          for (const v of value['values']) {
            if (obj[value['target']].startsWith(v)) {
              result = true;
            }
          }
          results.push(result);
          break;

        case 'endsWith':
          for (const v of value['values']) {
            if (obj[value['target']].endsWith(v)) {
              result = true;
            }
          }
          results.push(result);
          break;
      }
    }
    return results.length === 0 ? true : results.every(Boolean);
  });
}
