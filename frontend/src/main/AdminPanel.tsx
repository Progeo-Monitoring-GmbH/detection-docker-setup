import React from 'react';
import axiosConfig from '../axiosConfig.tsx';
import { Card, Col, Row, Button, ListGroup, Spinner } from 'react-bootstrap';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import {
  WebsocketContext,
  ReadyState,
} from '../components/ws/websocketContext.jsx';

type StorageInfo = {
  path?: string;
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
  sendMessage: (message: string) => void;
  wsMessage: any;
  readyState: number;
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
  logUpdatedPulse: boolean;
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
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private logContentRef = React.createRef<HTMLPreElement>();

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
      logUpdatedPulse: false,
    };
  }

  componentDidMount() {
    this.loadStorageInfo(false);
    if (this.props.readyState === ReadyState.OPEN) {
      this.requestLogFileList();
    }
  }

  componentDidUpdate(prevProps: AdminPanelProps, prevState: AdminPanelState) {
    if (
      prevProps.readyState !== this.props.readyState &&
      this.props.readyState === ReadyState.OPEN
    ) {
      this.requestLogFileList();
    }

    if (this.props.wsMessage && prevProps.wsMessage !== this.props.wsMessage) {
      this.handleWebSocketMessage(this.props.wsMessage);
    }

    if (
      prevProps.readyState !== this.props.readyState &&
      this.props.readyState !== ReadyState.OPEN &&
      this.state.logFiles.length === 0
    ) {
      this.loadLogFiles();
    }

    const focusedLogChanged =
      prevState.selectedLogFile !== this.state.selectedLogFile;
    const finishedLoadingFocusedLog =
      prevState.loadingLogContent && !this.state.loadingLogContent;

    if (
      (focusedLogChanged || finishedLoadingFocusedLog) &&
      this.state.selectedLogFile
    ) {
      this.scrollLogToBottom();
    }
  }

  componentWillUnmount() {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }

    if (this.props.readyState === ReadyState.OPEN) {
      this.props.sendMessage(JSON.stringify({ action: 'stop_stream' }));
    }
  }

  triggerLogUpdatedPulse = () => {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }

    this.setState({ logUpdatedPulse: true });
    this.pulseTimer = setTimeout(() => {
      this.setState({ logUpdatedPulse: false });
      this.pulseTimer = null;
    }, 1200);
  };

  scrollLogToBottom = () => {
    window.requestAnimationFrame(() => {
      const el = this.logContentRef.current;
      if (!el) {
        return;
      }
      el.scrollTop = el.scrollHeight;
    });
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
      const previousContent = this.state.selectedLogContent;
      const incomingContent = data.content || '';
      const selectedChanged = this.state.selectedLogFile !== (data.file || '');
      const contentChanged = incomingContent !== previousContent;

      this.setState({
        loadingLogContent: false,
        selectedLogContent: incomingContent,
        selectedLogFile: data.file || '',
      });

      const selected = this.state.logFiles.find(
        (item) => item.file === data.file,
      );
      const selectedMeta = {
        file: data.file || selected?.file || '',
        path: data.path || selected?.path || '',
        size_bytes: Number(data.size_bytes ?? selected?.size_bytes ?? 0),
        modified_at: data.modified_at || selected?.modified_at || '',
      } as LogFileItem;

      this.setState((prevState) => ({
        selectedLogMeta: selectedMeta,
        logFiles: prevState.logFiles.map((item) =>
          item.file === selectedMeta.file ? selectedMeta : item,
        ),
      }));

      if (!selectedChanged && contentChanged) {
        this.triggerLogUpdatedPulse();
      }
    } else if (type === 'error') {
      showErrorBar(
        this.props.enqueueSnackbar,
        `Log streaming error: ${data.message}`,
      );
    }
  };

  requestLogFileList = () => {
    if (this.props.readyState === ReadyState.OPEN) {
      this.setState({ loadingLogs: true });
      this.props.sendMessage(JSON.stringify({ action: 'list_files' }));
    }
  };

  streamLogFile = (file: string) => {
    if (this.props.readyState === ReadyState.OPEN) {
      this.setState({ loadingLogContent: true, selectedLogFile: file });
      this.props.sendMessage(
        JSON.stringify({ action: 'stream_file', file, lines: 500 }),
      );
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
        const storagePath = data.path || data.storage_info?.path || '';
        this.setState({
          loadingStorage: false,
          storageInfo: (data.storage_info || {}) as StorageInfo,
          storagePath,
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
      <Card className="mb-3 border-0 shadow-sm px-4 py-3">
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
                <b>Generated:</b> {this.state.storageInfo?.generated_at || '-'}
                {' | '}
                <b>Host:</b> {this.state.storageInfo?.host?.hostname || '-'}
                {' | '}
                <b>Kernel:</b> {this.state.storageInfo?.host?.kernel || '-'}
              </p>

              <Row>
                <Col md={4}>
                  <Card className="h-100">
                    <Card.Body>
                      <h6 style={{ fontWeight: 'bold' }}>Root Filesystem</h6>
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
                      <h6 style={{ fontWeight: 'bold' }}>Media</h6>
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
                      <h6 style={{ fontWeight: 'bold' }}>Logs</h6>
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
      <Card className="border-0 shadow-sm px-4 py-3">
        <Card.Body>
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h4 className="mb-0">Log Files</h4>
            <div className="d-flex align-items-center gap-2">
              <small className="text-muted">
                {this.props.readyState === ReadyState.OPEN
                  ? '🟢 Live streaming active'
                  : '🔴 Streaming offline'}
              </small>
              <small
                style={{
                  opacity: this.state.logUpdatedPulse ? 1 : 0,
                  transition: 'opacity 1.2s ease-out',
                  color: '#198754',
                  fontWeight: 600,
                }}
              >
                Updated
              </small>
            </div>
          </div>
          <Row>
            <Col md={4}>
              {this.state.loadingLogs ? (
                <Spinner animation="border" size="sm" />
              ) : (
                <ListGroup style={{ maxHeight: '520px' }}>
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
                ref={this.logContentRef}
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
  const wsContext = React.useContext(WebsocketContext) as any;

  return (
    <AdminPanel
      auth={auth}
      enqueueSnackbar={enqueueSnackbar}
      sendMessage={wsContext?.sendMessage || (() => {})}
      wsMessage={wsContext?.wsMessage}
      readyState={
        typeof wsContext?.readyState === 'number'
          ? wsContext.readyState
          : ReadyState.UNINSTANTIATED
      }
    />
  );
};

export default AdminPanelView;
