import { Card, Container, Spinner } from 'react-bootstrap';
import { useParams } from 'react-router';
import { HeatmapViewHeader, useLocationHeatmap } from './locationHeatmapShared';

const LocationHeatplotView = () => {
  const { id } = useParams();
  const { loading, response, limit, setLimit, refresh } =
    useLocationHeatmap(id);

  return (
    <Container className="py-4">
      <HeatmapViewHeader
        id={id}
        switchTo="heatmap2d"
        loading={loading}
        onRefresh={refresh}
      />

      <Card className="border-0 shadow-sm mb-3">
        <Card.Body>
          <h4 className="mb-1">Location Heatplot</h4>
          <div className="text-muted small">Location {id}</div>
          <label htmlFor="heatplot-limit" className="form-label mt-3 mb-1">
            Measurements: {limit}
          </label>
          <input
            id="heatplot-limit"
            type="range"
            className="form-range"
            min={1}
            max={500}
            step={1}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            aria-valuemin={1}
            aria-valuemax={500}
            aria-valuenow={limit}
          />
          <div className="d-flex justify-content-between text-muted small">
            <span>1</span>
            <span>500</span>
          </div>
        </Card.Body>
      </Card>

      {loading && (
        <Card className="border-0 shadow-sm">
          <Card.Body className="d-flex align-items-center gap-2 text-muted">
            <Spinner size="sm" animation="border" />
            Loading sensor measurements...
          </Card.Body>
        </Card>
      )}
    </Container>
  );
};

export default LocationHeatplotView;
