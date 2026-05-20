import { useContext, useEffect, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import axiosConfig from '../axiosConfig.tsx';
import { showErrorBar } from '../components/ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';
import { WebsocketContext } from '../components/ws/websocketContext.jsx';

type MeasurementRow = {
  id: number;
  device: number;
  data_interval: number;
  last_fetched: string | null;
  samples: number[];
  max_sample: number;
  avg_sample: number;
  non_zero_sample: number;
};

const formatDate = (value: string | null) => {
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const MeasurementsOverview = () => {
  const auth = useAuth();
  const [measurements, setMeasurements] = useState<MeasurementRow[]>([]);
  const { enqueueSnackbar } = useSnackbar();
  const ctx = useContext(WebsocketContext) || {};
  const wsMessage = (ctx as any).wsMessage;

  const loadMeasurements = () => {
    void axiosConfig.perform_get(
      auth,
      '/v1/status/measurements/',
      (response) => {
        const rows = (response?.data?.measurements || []) as MeasurementRow[];
        setMeasurements(rows);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load measurements: ${reason}`);
      },
    );
  };

  useEffect(() => {
    loadMeasurements();
  }, []);

  useEffect(() => {
    if (!wsMessage) {
      return;
    }
    loadMeasurements();
  }, [wsMessage]);

  const columns: TableColumn<MeasurementRow>[] = [
    {
      name: 'ID',
      selector: (row) => row.id,
      sortable: true,
      width: '90px',
    },
    {
      name: 'Device',
      selector: (row) => row.device,
      sortable: true,
      width: '110px',
    },
    {
      name: 'Interval (s)',
      selector: (row) => row.data_interval,
      sortable: true,
      width: '130px',
    },
    {
      name: 'Last Fetched',
      selector: (row) => formatDate(row.last_fetched),
      sortable: true,
      grow: 1.5,
    },
    {
      name: 'Samples',
      selector: (row) => row.samples.join(', '),
      grow: 2,
      wrap: true,
    },
    {
      name: 'Max',
      selector: (row) => row.max_sample,
      sortable: true,
      width: '110px',
    },
    {
      name: 'Avg',
      selector: (row) => Number(row.avg_sample.toFixed(2)),
      sortable: true,
      width: '110px',
    },
    {
      name: 'Non-zero',
      selector: (row) => row.non_zero_sample,
      sortable: true,
      width: '120px',
    },
  ];

  return (
    <div>
      <h2>Measurements Overview</h2>
      <DataTable
        columns={columns}
        data={measurements}
        pagination
        highlightOnHover
        pointerOnHover
      />
    </div>
  );
};
export default MeasurementsOverview;
