import { useContext, useEffect, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { Badge, Button } from 'react-bootstrap';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';
import { WebsocketContext } from '../components/ws/websocketContext';
import { log } from 'node:console';

type DeviceModel = {
  id: number;
  raw_hash: string;
  mac: string | null;
  project_id: string | null;
  hardware: string | null;
  version: string | null;
  chip_id: string | null;
  location: number | null;
  last_fetched: string | null;
  last_updated: string | null;
};

type AlarmInfo = {
  triggered: boolean;
  evaluated_at: string | null;
  max_value: number | null;
  exceeding_values: number[];
  threshold: number | null;
};

type DeviceStatus = {
  device: DeviceModel;
  online: boolean;
  last_seen: string | null;
  last_measurement: unknown;
  last_alarm: AlarmInfo | null;
  ip: string | null;
  mac: string | null;
  hostname: string | null;
};

type DeviceStatusWsMessage = {
  type?: string;
  ip?: string;
  ok?: boolean;
  devices?: DeviceStatus[];
  data?: unknown;
};

const DemoView = () => {
  const auth = useAuth(); 
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const { enqueueSnackbar } = useSnackbar();
  const ctx = useContext(WebsocketContext) as {
    wsMessage: unknown;
    readyState: number;
    sendMessage: (msg: string) => void;
  } | null;

  const wsMessage = ctx?.wsMessage;
  console.log('DemoView wsMessage', wsMessage);

  const formatDate = (value: string | null): string => {
    if (!value) {
      return '-';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return parsed.toLocaleString();
  };

  const formatMeasurement = (value: unknown): string => {
    if (value == null) {
      return '-';
    }
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      const preview = value.slice(0, 3).map((entry) => String(entry)).join(', ');
      return value.length > 3 ? `${preview}, ...` : preview;
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value as Record<string, unknown>);
      return keys.length ? `Object(${keys.join(', ')})` : 'Object(empty)';
    }
    return '-';
  };

  function pollPingTaskResult(taskId: string, deviceIp: string, attempt = 0) {
    const maxAttempts = 15;

    void axiosConfig.perform_get(
      auth,
      `/v1/status/ping_device_result/?task_id=${encodeURIComponent(taskId)}`,
      (response) => {
        const data = response?.data ?? {};
        const state = data.state;

        if (state === 'SUCCESS') {
          showSuccessBar(enqueueSnackbar, `Successfully pinged device (${deviceIp})`);
          console.log('Ping task result:', data.result);
          void fetchDeviceStatus();
          return;
        }

        if (state === 'FAILURE') {
          showErrorBar(enqueueSnackbar, `Ping task failed for device (${deviceIp})`);
          console.error('Ping task error:', data.error);
          return;
        }

        if (attempt + 1 >= maxAttempts) {
          showErrorBar(enqueueSnackbar, `Ping task timed out for device (${deviceIp})`);
          return;
        }

        setTimeout(() => {
          pollPingTaskResult(taskId, deviceIp, attempt + 1);
        }, 1000);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, `Could not check ping result for device (${deviceIp})`);
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
      },
    );
  }

  async function fetchDeviceStatus() {
    setLoading(true);
    return await axiosConfig.perform_get(
      auth,
      '/v1/status/devices/',
      (response) => {
        setDevices(response?.data?.devices ?? []);
        setLoading(false);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, `Could not fetch devices: ${error.message}`);
        if (error.response) {
          console.error(error.response.data);
        } else {
          console.error(error);
        }
        setLoading(false);
      },
    );
  }

  const columns: TableColumn<DeviceStatus>[] = [
      {
        id: 1,
        name: 'Device',
        sortable: true,
        selector: (row) => row.device.raw_hash,
        cell: (row) => (
          <div className="py-2">
            <div><strong>{row.device.raw_hash}</strong></div>
            <div>ID: {row.device.id}</div>
            <div>{row.device.hardware || '-'} | {row.device.version || '-'}</div>
          </div>
        ),
      },
      {
        id: 2,
        name: 'Network',
        cell: (row) => (
          <div className="py-2">
            <div>IP: {row.ip || '-'}</div>
            <div>MAC: {row.mac || row.device.mac || '-'}</div>
            <div>Host: {row.hostname || '-'}</div>
          </div>
        ),
      },
      {
        id: 3,
        name: 'Online',
        width: '120px',
        sortable: true,
        selector: (row) => (row.online ? 1 : 0),
        cell: (row) => (
          <Badge bg={row.online ? 'success' : 'secondary'}>
            {row.online ? 'Online' : 'Offline'}
          </Badge>
        ),
      },
      {
        id: 4,
        name: 'Last Seen',
        sortable: true,
        selector: (row) => row.last_seen || '',
        cell: (row) => <span>{formatDate(row.last_seen)}</span>,
      },
      {
        id: 5,
        name: 'Last Fetched',
        sortable: true,
        selector: (row) => row.device.last_fetched || '',
        cell: (row) => <span>{formatDate(row.device.last_fetched)}</span>,
      },
      {
        id: 6,
        name: 'Measurement',
        cell: (row) => <span>{formatMeasurement(row.last_measurement)}</span>,
      },
      {
        id: 7,
        name: 'Alarm',
        cell: (row) => {
          if (!row.last_alarm) {
            return <Badge bg="light" text="dark">No data</Badge>;
          }
          if (row.last_alarm.triggered) {
            return (
              <div className="py-2">
                <Badge bg="danger">Triggered</Badge>
                <div>Max: {row.last_alarm.max_value ?? '-'}</div>
              </div>
            );
          }
          return <Badge bg="success">OK</Badge>;
        },
      },
      {
        id: 8,
        name: 'Actions',
        width: '150px',
        cell: (row) => (
          <Button
            variant="outline-success"
            size="sm"
            disabled={!row.ip}
            onClick={() => {
              const ip = row.ip;
              if (!ip) {
                showErrorBar(enqueueSnackbar, 'Cannot ping device: missing IP');
                return;
              }

              void axiosConfig.perform_get(
                auth,
                `/v1/status/ping_device/?ip=${encodeURIComponent(ip)}`,
                (response) => {
                  showSuccessBar(enqueueSnackbar, `Queued ping task for device (${ip})`);
                  if (response?.data?.task_id) {
                    pollPingTaskResult(response.data.task_id, ip);
                  }
                },
                (error) => {
                  showErrorBar(enqueueSnackbar, `Could not queue ping for device (${ip})`);
                  if (error.response) {
                    console.error(error.response.data);
                  } else {
                    console.error(error);
                  }
                },
              );
            }}
          >
            Ping
          </Button>
        ),
      },
    ];


  useEffect(() => {
    void fetchDeviceStatus();
  }, []);

  useEffect(() => {
    if (!wsMessage) {
      return;
    }

    if (Array.isArray(wsMessage.devices)) {
      setDevices(wsMessage.devices);
      return;
    }

    const payload = wsMessage.data as { devices?: DeviceStatus[] } | DeviceStatus[] | undefined;
    if (payload && !Array.isArray(payload) && Array.isArray(payload.devices)) {
      setDevices(payload.devices);
      return;
    }

    if (Array.isArray(payload)) {
      setDevices(payload as DeviceStatus[]);
      return;
    }

    // For ping responses, update the matching device row from websocket message.
    if (wsMessage.type === 'ping_device_result' && wsMessage.ip) {
      setDevices((prev) =>
        prev.map((entry) =>
          entry.ip === wsMessage.ip
            ? { ...entry, online: Boolean(wsMessage.ok) }
            : entry,
        ),
      );
    }
  }, [wsMessage]);

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <div className="d-flex mb-3 justify-content-between align-items-center">
        <h3 className="mb-0">Device Status Overview</h3>
        <Button variant="outline-primary" onClick={() => void fetchDeviceStatus()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {devices.length > 0 ? (
        <DataTable
          columns={columns}
          data={devices}
          progressPending={loading}
          highlightOnHover
        />
      ) : (
        <div>No devices found</div>
      )}

    </div>
  );
};

export default DemoView;
