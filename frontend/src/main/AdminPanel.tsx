import React from 'react';
import axiosConfig from '../axiosConfig.tsx';
import { Card, Col, Row, Button, ListGroup, Spinner } from 'react-bootstrap';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';

type StorageInfo = {
  generated_at?: string;
  host?: {
    hostname?: string;
    kernel?: string;
  };
  storage?: {
    root?: {
      filesystem?: string;
      mount?: string;
      total_bytes?: number;
      used_bytes?: number;
      available_bytes?: number;
      used_percent?: string;
    };
    media?: {
      path?: string;
      filesystem?: string;
      mount?: string;
      total_bytes?: number;
      used_bytes?: number;
      available_bytes?: number;
      used_percent?: string;
      directory_size_bytes?: number;
    };
    logs?: {
      path?: string;
      directory_size_bytes?: number;
    };
  };
};

type LogFileItem = {
  file: string;
  path: string;
  size_bytes: number;
  modified_at: string;
};

type AdminPanelProps = {
  auth: any;
  enqueueSnackbar: any;
};

type AdminPanelState = {
  loadingStorage: boolean;
  loadingLogs: boolean;
  loadingLogContent: boolean;
  storageInfo: StorageInfo | null;
  storagePath: string;
  logFiles: LogFileItem[];
  selectedLogFile: string;
  selectedLogContent: string;
  selectedLogMeta: LogFileItem | null;
  wsConnected: boolean;
};

const bytesToReadable = (value?: number) => {
  if (!Number.isFinite(value as number) || (value as number) < 0) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = Number(value);
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(val >= 10 ? 1 : 2)} ${units[idx]}`;
};

class AdminPanel extends React.PureComponent<AdminPanelProps, AdminPanelState> {
  private ws: WebSocket | null = null;

  constructor(props: AdminPanelProps) {
    super(props);
    this.state = {
      loadingStorage: true,
      loadingLogs: true,
      loadingLogContent: false,
      storageInfo: null,
      storagePath: '',
      logFiles: [],
      selectedLogFile: '',
      selectedLogContent: '',
      selectedLogMeta: null,
      wsConnected: false,
    };
  }

  componentDidMount() {
    this.loadStorageInfo(false);
    this.initializeWebSocket();
  }

  componentWillUnmount() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  initializeWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/logs/stream/`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.setState({ wsConnected: true });
        this.requestLogFileList();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleWebSocketMessage(data);
        } catch (error) {
          console.error('Failed to parse websocket message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('Websocket error:', error);
        showErrorBar(
          this.props.enqueueSnackbar,
          'Log streaming connection error',
        );
      };

      this.ws.onclose = () => {
        this.setState({ wsConnected: false });
        // Attempt to reconnect after 3 seconds
        setTimeout(() => this.initializeWebSocket(), 3000);
      };
    } catch (error) {
      console.error('Failed to initialize websocket:', error);
    }
  };

  handleWebSocketMessage = (data: any) => {
    const type = data.type || '';

    if (type === 'file_list') {
      const files = (data.files || []) as LogFileItem[];
      this.setState({ loadingLogs: false, logFiles: files });
      if (files.length > 0 && !this.state.selectedLogFile) {
        this.streamLogFile(files[0].file);
      }
    } else if (type === 'log_content') {
      this.setState({
        loadingLogContent: false,
        selectedLogContent: data.content || '',
        selectedLogFile: data.file || '',
      });
      const selected =
        this.state.logFiles.find((item) => item.file === data.file) || null;
      this.setState({ selectedLogMeta: selected });
    } else if (type === 'error') {
      showErrorBar(
        this.props.enqueueSnackbar,
        `Log streaming error: ${data.message}`,
      );
    }
  };

  requestLogFileList = () => {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'list_files' }));
    }
  };

  streamLogFile = (file: string) => {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.setState({ loadingLogContent: true, selectedLogFile: file });
      this.ws.send(JSON.stringify({ action: 'stream_file', file, lines: 500 }));
    } else {
      // Fallback to HTTP if websocket not connected
      this.loadLogFile(file);
    }
  };

  loadStorageInfo = (refresh: boolean) => {
    this.setState({ loadingStorage: true });
    const suffix = refresh ? '?refresh=true' : '';
    void axiosConfig.perform_get(
      this.props.auth,
      `/v1/status/admin/storage_info/${suffix}`,
      (response) => {
        const data = response?.data || {};
        this.setState({
          loadingStorage: false,
          storageInfo: (data.storage_info || {}) as StorageInfo,
          storagePath: data.path || '',
        });
        if (refresh && data.refresh_task_id) {
          showSuccessBar(
            this.props.enqueueSnackbar,
            `Storage refresh task queued (${data.refresh_task_id}).`,
          );
        }
      },
      (error) => {
        this.setState({ loadingStorage: false });
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          this.props.enqueueSnackbar,
          `Could not load storage info: ${reason}`,
        );
      },
    );
  };

  loadLogFiles = () => {
    this.setState({ loadingLogs: true });
    void axiosConfig.perform_get(
      this.props.auth,
      '/v1/status/admin/log_files/',
      (response) => {
        const files = (response?.data?.files || []) as LogFileItem[];
        this.setState({ loadingLogs: false, logFiles: files });
        if (files.length > 0) {
          this.loadLogFile(files[0].file);
        }
      },
      (error) => {
        this.setState({ loadingLogs: false });
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          this.props.enqueueSnackbar,
          `Could not load log file list: ${reason}`,
        );
      },
    );
  };

  loadLogFile = (file: string) => {
    this.setState({ loadingLogContent: true, selectedLogFile: file });
    void axiosConfig.perform_get(
      this.props.auth,
      `/v1/status/admin/log_files/?file=${encodeURIComponent(file)}&lines=500`,
      (response) => {
        const data = response?.data || {};
        const selected =
          this.state.logFiles.find((item) => item.file === file) || null;
        this.setState({
          loadingLogContent: false,
          selectedLogContent: data.content || '',
          selectedLogMeta: selected,
        });
      },
      (error) => {
        this.setState({ loadingLogContent: false });
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          this.props.enqueueSnackbar,
          `Could not read log file: ${reason}`,
        );
      },
    );
  };

  renderStorageCard() {
    const storage = this.state.storageInfo?.storage || {};
    const root = storage.root || {};
    const media = storage.media || {};
    const logs = storage.logs || {};

    return (
      <Card className="mb-3 border-0 shadow-sm">
        <Card.Body>
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h4 className="mb-0">Host Storage</h4>
            <Button
              variant="outline-primary"
              size="sm"
              onClick={() => this.loadStorageInfo(true)}
              disabled={this.state.loadingStorage}
            >
              Refresh via Celery
            </Button>
          </div>

          {this.state.loadingStorage ? (
            <Spinner animation="border" size="sm" />
          ) : (
            <>
              <p className="text-muted mb-2">
                Generated: {this.state.storageInfo?.generated_at || '-'}
                {' | '}Host: {this.state.storageInfo?.host?.hostname || '-'}
                {' | '}Kernel: {this.state.storageInfo?.host?.kernel || '-'}
              </p>
              <p className="text-muted mb-3">
                JSON file: {this.state.storagePath || '-'}
              </p>

              <Row>
                <Col md={4}>
                  <Card className="h-100">
                    <Card.Body>
                      <h6>Root Filesystem</h6>
                      <div>Total: {bytesToReadable(root.total_bytes)}</div>
                      <div>Used: {bytesToReadable(root.used_bytes)}</div>
                      <div>
                        Available: {bytesToReadable(root.available_bytes)}
                      </div>
                      <div>Usage: {root.used_percent || '-'}</div>
                    </Card.Body>
                  </Card>
                </Col>
                <Col md={4}>
                  <Card className="h-100">
                    <Card.Body>
                      <h6>Media</h6>
                      <div>Path: {media.path || '-'}</div>
                      <div>Total: {bytesToReadable(media.total_bytes)}</div>
                      <div>Used: {bytesToReadable(media.used_bytes)}</div>
                      <div>
                        Dir Size: {bytesToReadable(media.directory_size_bytes)}
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
                <Col md={4}>
                  <Card className="h-100">
                    <Card.Body>
                      <h6>Logs</h6>
                      <div>Path: {logs.path || '-'}</div>
                      <div>
                        Dir Size: {bytesToReadable(logs.directory_size_bytes)}
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
              </Row>
            </>
          )}
        </Card.Body>
      </Card>
    );
  }

  renderLogsCard() {
    return (
      <Card className="border-0 shadow-sm">
        <Card.Body>
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h4 className="mb-0">Log Files</h4>
            <small className="text-muted">
              {this.state.wsConnected
                ? '🟢 Live streaming active'
                : '🔴 Streaming offline'}
            </small>
          </div>
          <Row>
            <Col md={4}>
              {this.state.loadingLogs ? (
                <Spinner animation="border" size="sm" />
              ) : (
                <ListGroup style={{ maxHeight: '520px', overflowY: 'auto' }}>
                  {this.state.logFiles.map((file) => (
                    <ListGroup.Item
                      action
                      key={file.file}
                      active={file.file === this.state.selectedLogFile}
                      onClick={() => this.streamLogFile(file.file)}
                    >
                      <div>{file.file}</div>
                      <small className="text-muted">
                        {bytesToReadable(file.size_bytes)}
                      </small>
                    </ListGroup.Item>
                  ))}
                </ListGroup>
              )}
            </Col>
            <Col md={8}>
              <div className="mb-2 text-muted">
                {this.state.selectedLogMeta?.path ||
                  this.state.selectedLogFile ||
                  'No file selected'}
              </div>
              <pre
                style={{
                  background: '#101419',
                  color: '#d9e2ec',
                  borderRadius: '8px',
                  padding: '12px',
                  minHeight: '520px',
                  maxHeight: '520px',
                  overflow: 'auto',
                  fontSize: '0.82rem',
                }}
              >
                {this.state.loadingLogContent
                  ? 'Loading log file...'
                  : this.state.selectedLogContent || 'No log content.'}
              </pre>
            </Col>
          </Row>
        </Card.Body>
      </Card>
    );
  }

  render() {
    return (
      <>
        <h2 className="mb-3">Admin Panel</h2>
        {this.renderStorageCard()}
        {this.renderLogsCard()}
      </>
    );
  }
}

const AdminPanelView = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  return <AdminPanel auth={auth} enqueueSnackbar={enqueueSnackbar} />;
};

export default AdminPanelView;
