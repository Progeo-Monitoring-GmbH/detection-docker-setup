import { useEffect, useRef, useState } from 'react';
import { Button, Form, Modal, Spinner } from 'react-bootstrap';
import { Copy } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import LocationPicker, { type PickableLocation } from '../location/LocationPicker';
import { showRequestError } from '../ui/Snackbar.jsx';
import { MIN_AREA_POINTS } from './heatLimitations';
import type { HeatLimitation } from './sensorHeatmapTypes';

/** One Lageplan of GET /v1/location/<pk>/heat-limitations/ with its areas. */
type HeatLimitationSourcePlan = {
  id: number;
  name?: string | null;
  is_active?: boolean;
  url?: string | null;
  heat_limitations?: HeatLimitation[] | null;
};

/** GET /v1/location/<pk>/heat-limitations/: the location's plans and the
 * target plan's areas - the payload the copy picks from. */
type HeatLimitationSource = {
  location_id?: number;
  lageplan_id?: number | null;
  plans?: HeatLimitationSourcePlan[];
  heat_limitations?: HeatLimitation[] | null;
};

/** The copyable areas of one plan: its own list, falling back to the
 * response's target list (a plan without one). Areas too small to store are
 * left out, like the backend does. */
const planAreas = (source: HeatLimitationSource | null, planId: number | null): HeatLimitation[] => {
  if (!source) {
    return [];
  }
  const plan = (source.plans ?? []).find((entry) => entry.id === planId);
  const listed =
    plan?.heat_limitations ?? (planId == null || planId === source.lageplan_id ? source.heat_limitations : null);
  return (listed ?? []).filter((area) => Array.isArray(area.points) && area.points.length >= MIN_AREA_POINTS);
};

type HeatLimitationCopyPickerProps = {
  onClose: () => void;
  /** Copies the picked areas into the current plan; false if one failed. */
  onCopy: (areas: HeatLimitation[]) => Promise<boolean>;
};

/**
 * "Copy from existing project": the modal behind the bar's copy button, with
 * the shared searchable LocationPicker for the source project
 * (GET /v1/location/min/), the source Lageplans (GET
 * /v1/location/<pk>/heat-limitations/) and their areas with name and point
 * count - all preselected, so copying all is one click while unchecking
 * leaves just the wanted ones. The parent mounts it per opening, so the
 * source picker starts empty again after it closes.
 */
const HeatLimitationCopyPicker = ({ onClose, onCopy }: HeatLimitationCopyPickerProps) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [locations, setLocations] = useState<PickableLocation[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [source, setSource] = useState<HeatLimitationSource | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [planId, setPlanId] = useState<number | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [copying, setCopying] = useState(false);
  // Answers of an older source selection are dropped.
  const requestRef = useRef(0);

  const sourcePlans = source?.plans ?? [];
  const areas = planAreas(source, planId);
  const chosen = areas.filter((area) => selected.includes(area.id));

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/location/min/',
      (response) => {
        setLocations(Array.isArray(response?.data) ? response.data : []);
        setLocationsLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('heat_limit_copy_locations_failed'), error);
        setLocationsLoading(false);
      },
    );
    // Once per opening - the modal is mounted for one copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectSource = (location: PickableLocation | null) => {
    const request = ++requestRef.current;
    const locationId = location?.id ?? null;
    setSourceId(locationId);
    setSource(null);
    setPlanId(null);
    setSelected([]);
    if (locationId == null) {
      setSourceLoading(false);
      return;
    }
    setSourceLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/heat-limitations/`,
      (response) => {
        if (request !== requestRef.current) {
          return;
        }
        const data = (response?.data ?? null) as HeatLimitationSource | null;
        const nextPlanId = data?.lageplan_id ?? data?.plans?.[0]?.id ?? null;
        setSource(data);
        setPlanId(nextPlanId);
        setSelected(planAreas(data, nextPlanId).map((area) => area.id));
        setSourceLoading(false);
      },
      (error) => {
        if (request !== requestRef.current) {
          return;
        }
        showRequestError(enqueueSnackbar, t('heat_limit_copy_load_failed'), error);
        setSourceLoading(false);
      },
    );
  };

  const selectPlan = (next: number | null) => {
    setPlanId(next);
    setSelected(planAreas(source, next).map((area) => area.id));
  };

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) =>
      checked
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((entry) => entry !== id),
    );

  const close = () => {
    if (!copying) {
      onClose();
    }
  };

  const submit = async () => {
    if (!chosen.length || copying) {
      return;
    }
    setCopying(true);
    const copied = await onCopy(chosen);
    setCopying(false);
    if (copied) {
      onClose();
    }
  };

  return (
    <Modal show onHide={close} centered>
      <Modal.Header closeButton>
        <Modal.Title>{t('heat_limit_copy')}</Modal.Title>
      </Modal.Header>
      <Modal.Body className="d-flex flex-column gap-3">
        <Form.Group>
          <Form.Label htmlFor="heat-limit-copy-source">{t('heat_limit_copy_source')}</Form.Label>
          <LocationPicker
            id="heat-limit-copy-source"
            locations={locations}
            value={sourceId}
            onChange={selectSource}
            loading={locationsLoading}
            disabled={copying}
          />
        </Form.Group>

        {sourceLoading && (
          <div className="text-center py-2">
            <Spinner animation="border" size="sm" />
          </div>
        )}

        {!sourceLoading && source && sourcePlans.length > 1 && (
          <Form.Group>
            <Form.Label htmlFor="heat-limit-copy-plan">{t('heat_limit_copy_plan')}</Form.Label>
            <Form.Select
              id="heat-limit-copy-plan"
              value={planId ?? ''}
              disabled={copying}
              onChange={(event) => selectPlan(Number(event.target.value))}
            >
              {sourcePlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name || `#${plan.id}`}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        )}

        {!sourceLoading && source && (
          <div>
            <div className="small text-muted mb-1">{t('heat_limit_copy_areas')}</div>
            {areas.length === 0 ? (
              <div className="small text-muted">{t('heat_limit_copy_empty')}</div>
            ) : (
              <div className="d-flex flex-column gap-2">
                {areas.map((area, index) => (
                  <Form.Check
                    key={area.id}
                    type="checkbox"
                    id={`heat-limit-copy-area-${area.id}`}
                    checked={selected.includes(area.id)}
                    disabled={copying}
                    onChange={(event) => toggle(area.id, event.target.checked)}
                    label={
                      <span>
                        {area.name || t('heat_limit_numbered', { number: index + 1 })}
                        <span className="text-muted small ms-2">
                          {t('heat_limit_copy_points', { count: area.points.length })}
                        </span>
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={close} disabled={copying}>
          {t('heat_limit_cancel')}
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={copying || chosen.length === 0}>
          {copying ? <Spinner size="sm" animation="border" className="me-1" /> : <Copy className="me-1" />}
          {t('heat_limit_copy_confirm', { count: chosen.length })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default HeatLimitationCopyPicker;
