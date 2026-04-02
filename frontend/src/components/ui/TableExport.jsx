import React from 'react';
import { C_TYPES, downloadCSV } from '../../helper';
import { Button } from 'react-bootstrap';
import {
  columnsDirectContracts,
  columnsDocument,
  columnsMeters,
  columnsRentContracts,
  columnsRooms,
  columnsTemplates,
} from '../datatables/configs';

export function useTableExport(cType, data) {
  const Export = ({ onExport }) => (
    <Button onClick={(e) => onExport(e.target.value)}>Export</Button>
  );

  const memoExport = React.useMemo(() => {
    let columns;
    switch (cType) {
      case C_TYPES[0].model: // Direct-Contract
        columns = columnsDirectContracts;
        break;
      case C_TYPES[1].model: // Rent-Contract
        columns = columnsRentContracts;
        break;
      case 'Rooms':
        columns = columnsRooms;
        break;
      case 'Meters':
        columns = columnsMeters;
        break;
      case 'Templates':
        columns = columnsTemplates;
        break;
      case 'Documents':
        columns = columnsDocument(undefined, () => {}, []);
        break;
      default:
        console.error('Unhandled Table-Type:', cType);
    }

    return <Export onExport={() => downloadCSV(columns, data)} />;
  }, [cType, data]);

  return { memoExport };
}
