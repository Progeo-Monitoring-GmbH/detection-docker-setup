import { Badge, Button, Card } from 'react-bootstrap';
import {
  Wifi,
  WifiOff,
  PencilSquare,
  Trash,
  Image,
} from 'react-bootstrap-icons';
import { useNavigate } from 'react-router';
import { prettyDate } from '../../helper';
import '../ui/css/DeviceCard.css';

const DeviceCard = ({ device, onIdentify, onDelete, loading }) => {
  const navigate = useNavigate();

  return (
    <Card className="mb-3 h-100 p-3 device-card">
      <Card.Body>
        <div className="d-flex justify-content-between align-items-start mb-3">
          <div>
            <Card.Title className="mb-1">{device.raw_hash}</Card.Title>
            <small className="text-muted">ID: {device.id}</small>
          </div>
          <div>
            {device.online ? (
              <Badge bg="success">
                <Wifi className="me-1" />
                Online
              </Badge>
            ) : (
              <Badge bg="secondary">
                <WifiOff className="me-1" />
                Offline
              </Badge>
            )}
          </div>
        </div>

        <div className="mb-3">
          <small className="d-block text-muted">
            <strong>Hardware:</strong> {device.hardware || '-'}
          </small>
          <small className="d-block text-muted">
            <strong>Version:</strong> {device.version || '-'}
          </small>
          <small className="d-block text-muted">
            <strong>Chip ID:</strong> {device.chip_id || '-'}
          </small>
        </div>

        <div className="mb-3">
          <small className="d-block text-muted">
            <strong>IP:</strong> {device.device_ip || '-'}
          </small>
          <small className="d-block text-muted">
            <strong>MAC:</strong> {device.mac || '-'}
          </small>
        </div>

        <div className="mb-3">
          <small className="d-block text-muted">
            <strong>Last Fetched:</strong> {prettyDate(device.last_fetched)}
          </small>
        </div>

        <div className="d-flex gap-2 flex-wrap">
          <Button
            variant="outline-success"
            size="sm"
            disabled={!device.device_ip || loading}
            onClick={() => onIdentify(device.device_ip, device.id)}
            title="Identify Device"
          >
            <Wifi className="me-1" />
            Identify
          </Button>

          <Button
            variant="outline-warning"
            size="sm"
            onClick={() => navigate(`/device/${device.id}/update`)}
            title="Update device settings"
          >
            <PencilSquare className="me-1" />
            Edit
          </Button>

          <Button
            variant="outline-info"
            size="sm"
            onClick={() => navigate(`/device/${device.id}/editor/`)}
            title="Open sensor editor"
          >
            <Image className="me-1" />
            Editor
          </Button>

          <Button
            variant="outline-primary"
            size="sm"
            onClick={() => navigate(`/device/${device.id}/detail`)}
            title="Open measurement detail"
          >
            Details
          </Button>

          <Button
            variant="outline-danger"
            size="sm"
            onClick={() => onDelete(device.id)}
            disabled={loading}
            title="Delete device"
          >
            <Trash className="me-1" />
            Delete
          </Button>
        </div>
      </Card.Body>
    </Card>
  );
};

export default DeviceCard;
