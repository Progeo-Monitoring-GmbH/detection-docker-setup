import { useEffect, useState } from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { Save } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import PillButton from '../components/ui/kit/PillButton';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { repeatedTestId } from '../testIds';
import {
  asAnswer,
  coverage,
  deviceColor,
  type DeviceInputsAnswer,
  draftsFrom,
  inputRuns,
  type InputsDraft,
  isDirty,
  isLinear,
  numberRanges,
  savePayload,
  type Segment,
  segmentsOf,
  withInputCount,
  withRun,
} from './deviceInputs';
import { Notice, StepCard } from './LageplanWizardComponents';
import './DeviceInputsStep.css';

const URL = '/v1/status/measure_points/device_inputs/';

/** The overview: the location's sensor numbers on top, coloured by the device
 * measuring them; below each device's inputs; bands join the inputs to the
 * sensors they measure - a jump shows as a band of its own (orange), free
 * inputs as gaps, sensors no input measures in red under the strip. */
export const DeviceInputsOverview = ({
  drafts,
  sensors,
}: {
  drafts: InputsDraft[];
  sensors: number[];
}) => {
  const width = 1000;
  const stripTop = 4;
  const stripHeight = 16;
  const barTop = 150;
  const barHeight = 16;
  const gap = 18;
  const measured = drafts.flatMap((draft) => draft.inputs.filter((sensor): sensor is number => sensor != null));
  const highest = Math.max(1, ...sensors, ...measured);
  const sensorX = (sensor: number) => ((sensor - 1) / highest) * width;
  const totalInputs = drafts.reduce((sum, draft) => sum + Math.max(1, draft.inputs.length), 0);
  const scale = (width - gap * Math.max(0, drafts.length - 1)) / Math.max(1, totalInputs);
  const { missing } = coverage(drafts, sensors);

  let offset = 0;
  const devices = drafts.map((draft, index) => {
    const size = Math.max(1, draft.inputs.length) * scale;
    const left = offset;
    offset += size + gap;
    return { draft, index, left, size, inputX: (position: number) => left + (position - 1) * scale };
  });

  return (
    <svg
      className="device-inputs-overview"
      viewBox={`0 0 ${width} 200`}
      role="img"
      aria-label="Which device input measures which sensor"
      data-testid="device-inputs-overview"
    >
      <rect x={0} y={stripTop} width={width} height={stripHeight} rx={3} className="device-inputs-strip" />
      {devices.flatMap(({ draft, index }) =>
        inputRuns(draft.inputs).map((run) => {
          const low = Math.min(run.start, run.end);
          const high = Math.max(run.start, run.end);
          return (
            <rect
              key={`strip-${draft.deviceId}-${run.from}`}
              x={sensorX(low)}
              y={stripTop}
              width={Math.max(1.5, sensorX(high + 1) - sensorX(low))}
              height={stripHeight}
              fill={deviceColor(index)}
            />
          );
        }),
      )}
      {missing.map((sensor) => (
        <rect
          key={`missing-${sensor}`}
          x={sensorX(sensor)}
          y={stripTop + stripHeight + 2}
          width={Math.max(1.5, width / highest)}
          height={5}
          className="device-inputs-missing"
        />
      ))}
      {[1, highest].map((sensor) => (
        <text key={`tick-${sensor}`} x={sensor === 1 ? 0 : width} y={42} className="device-inputs-tick"
          textAnchor={sensor === 1 ? 'start' : 'end'}>
          {sensor}
        </text>
      ))}
      {devices.flatMap(({ draft, index, inputX }) =>
        segmentsOf(draft.inputs)
          .filter((segment) => segment.start != null && segment.end != null)
          .map((segment) => {
            const low = Math.min(segment.start as number, segment.end as number);
            const high = Math.max(segment.start as number, segment.end as number);
            const a = inputX(segment.from);
            const b = inputX(segment.to + 1);
            const sa = sensorX(low);
            const sb = sensorX(high + 1);
            const top = stripTop + stripHeight + 8;
            return (
              <path
                key={`band-${draft.deviceId}-${segment.from}`}
                d={`M${a},${barTop} C${a},${barTop - 50} ${sa},${top + 50} ${sa},${top} L${sb},${top} `
                  + `C${sb},${top + 50} ${b},${barTop - 50} ${b},${barTop} Z`}
                fill={segment.kind === 'jump' ? 'var(--progeo-orange)' : deviceColor(index)}
                className={segment.kind === 'jump' ? 'device-inputs-band device-inputs-band--jump' : 'device-inputs-band'}
              />
            );
          }),
      )}
      {devices.map(({ draft, index, left, size, inputX }) => (
        <g key={`bar-${draft.deviceId}`}>
          <rect x={left} y={barTop} width={size} height={barHeight} rx={3} fill={deviceColor(index)}
            className="device-inputs-bar" />
          {segmentsOf(draft.inputs)
            .filter((segment) => segment.kind === 'free')
            .map((segment) => (
              <rect key={`free-${segment.from}`} x={inputX(segment.from)} y={barTop - 3}
                width={Math.max(2, (segment.to - segment.from + 1) * scale)} height={barHeight + 6}
                className="device-inputs-free" />
            ))}
          <text x={left} y={barTop + barHeight + 18} className="device-inputs-bar-label" fill={deviceColor(index)}>
            {draft.label.split(' · ')[0]} · inputs 1 – {draft.inputs.length}
          </text>
        </g>
      ))}
    </svg>
  );
};

const segmentTag = (segment: Segment, doubled: Set<number>) => {
  if (segment.start != null && segment.end != null) {
    const low = Math.min(segment.start, segment.end);
    const high = Math.max(segment.start, segment.end);
    if ([...doubled].some((sensor) => sensor >= low && sensor <= high)) {
      return { label: 'on two inputs', tone: 'doubled' };
    }
  }
  return {
    count: { label: 'continuous', tone: 'count' },
    jump: { label: 'jump', tone: 'jump' },
    free: { label: 'free', tone: 'free' },
  }[segment.kind];
};

const numberValue = (value: string) => (value.trim() === '' ? null : Number(value));

/** One section of a device: inputs from-to measure sensors from start on, up
 * or down - or nothing (start empty: free). Applied when changed. */
const SegmentRow = ({
  segment,
  deviceId,
  doubled,
  onApply,
}: {
  segment: Segment;
  deviceId: number;
  doubled: Set<number>;
  onApply: (from: number, to: number, start: number | null, direction: 'up' | 'down') => void;
}) => {
  const [from, setFrom] = useState(String(segment.from));
  const [to, setTo] = useState(String(segment.to));
  const [start, setStart] = useState(segment.start == null ? '' : String(segment.start));
  const [direction, setDirection] = useState(segment.direction);
  const low = numberValue(from);
  const high = numberValue(to);
  const first = numberValue(start);
  const valid = low != null && high != null && low >= 1 && high >= low
    && (first == null || (first >= 1 && (direction === 'up' || first - (high - low) >= 1)));
  const changed = from !== String(segment.from) || to !== String(segment.to)
    || start !== (segment.start == null ? '' : String(segment.start)) || direction !== segment.direction;
  const last = first == null || low == null || high == null ? null
    : direction === 'up' ? first + (high - low) : first - (high - low);
  const tag = segmentTag(segment, doubled);
  const key = `${deviceId}-${segment.from}`;

  return (
    <div className="device-inputs-segment" {...repeatedTestId('device-inputs-segment', key)}>
      <span className="device-inputs-word">Inputs</span>
      <Form.Control size="sm" type="number" min={1} value={from} aria-label="First input"
        className="device-inputs-number" onChange={(event) => setFrom(event.target.value)}
        {...repeatedTestId('device-inputs-segment-from', key)} />
      <span>–</span>
      <Form.Control size="sm" type="number" min={1} value={to} aria-label="Last input"
        className="device-inputs-number" onChange={(event) => setTo(event.target.value)}
        {...repeatedTestId('device-inputs-segment-to', key)} />
      <span className="device-inputs-word">→ sensors from</span>
      <Form.Control size="sm" type="number" min={1} value={start} placeholder="free" aria-label="First sensor"
        className="device-inputs-number" onChange={(event) => setStart(event.target.value)}
        {...repeatedTestId('device-inputs-segment-start', key)} />
      <span className="device-inputs-last">{last != null ? `to ${last}` : 'no sensor'}</span>
      {/* Free inputs count nothing - the direction only with a first sensor. */}
      {first != null && (
        <Form.Select size="sm" value={direction} aria-label="Counting" className="device-inputs-direction"
          onChange={(event) => setDirection(event.target.value as 'up' | 'down')}
          {...repeatedTestId('device-inputs-segment-direction', key)}>
          <option value="up">ascending</option>
          <option value="down">descending</option>
        </Form.Select>
      )}
      <span className={`device-inputs-tag device-inputs-tag--${tag.tone}`}>{tag.label}</span>
      <span className="device-inputs-actions">
        {changed && (
          <Button size="sm" variant="primary" disabled={!valid}
            onClick={() => valid && onApply(low as number, high as number, first, direction)}
            {...repeatedTestId('device-inputs-segment-apply', key)}>
            Apply
          </Button>
        )}
        {segment.kind !== 'free' && !changed && (
          <Button size="sm" variant="outline-secondary"
            onClick={() => onApply(segment.from, segment.to, null, 'up')}
            {...repeatedTestId('device-inputs-segment-free', key)}>
            Make free
          </Button>
        )}
      </span>
    </div>
  );
};

/** A new section on top of the device's inputs (it overwrites what was there). */
const NewSegmentRow = ({
  deviceId,
  next,
  onAdd,
}: {
  deviceId: number;
  next: number;
  onAdd: (from: number, to: number, start: number, direction: 'up' | 'down') => void;
}) => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [start, setStart] = useState('');
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const low = numberValue(from);
  const high = numberValue(to);
  const first = numberValue(start);
  const valid = low != null && high != null && first != null && low >= 1 && high >= low && first >= 1
    && (direction === 'up' || first - (high - low) >= 1);
  return (
    <div className="device-inputs-segment device-inputs-segment--new"
      {...repeatedTestId('device-inputs-new', deviceId)}>
      <span className="device-inputs-word">Add: inputs</span>
      <Form.Control size="sm" type="number" min={1} value={from} placeholder={String(next)} aria-label="First input"
        className="device-inputs-number" onChange={(event) => setFrom(event.target.value)}
        {...repeatedTestId('device-inputs-new-from', deviceId)} />
      <span>–</span>
      <Form.Control size="sm" type="number" min={1} value={to} aria-label="Last input"
        className="device-inputs-number" onChange={(event) => setTo(event.target.value)}
        {...repeatedTestId('device-inputs-new-to', deviceId)} />
      <span className="device-inputs-word">→ sensors from</span>
      <Form.Control size="sm" type="number" min={1} value={start} aria-label="First sensor"
        className="device-inputs-number" onChange={(event) => setStart(event.target.value)}
        {...repeatedTestId('device-inputs-new-start', deviceId)} />
      <Form.Select size="sm" value={direction} aria-label="Counting" className="device-inputs-direction"
        onChange={(event) => setDirection(event.target.value as 'up' | 'down')}>
        <option value="up">ascending</option>
        <option value="down">descending</option>
      </Form.Select>
      <span className="device-inputs-actions">
        <Button size="sm" variant="outline-primary" disabled={!valid}
          onClick={() => {
            onAdd(low as number, high as number, first as number, direction);
            setFrom('');
            setTo('');
            setStart('');
          }}
          {...repeatedTestId('device-inputs-new-add', deviceId)}>
          Add section
        </Button>
      </span>
    </div>
  );
};

/** One device: its count, its sections, a new section. */
const DeviceSections = ({
  draft,
  index,
  doubled,
  onChange,
}: {
  draft: InputsDraft;
  index: number;
  doubled: Set<number>;
  onChange: (next: InputsDraft) => void;
}) => {
  const [count, setCount] = useState(String(draft.inputs.length));
  useEffect(() => setCount(String(draft.inputs.length)), [draft.inputs.length]);
  const commitCount = () => {
    const value = numberValue(count);
    if (value != null && value >= 0 && value !== draft.inputs.length) {
      onChange(withInputCount(draft, value));
    } else {
      setCount(String(draft.inputs.length));
    }
  };
  const linear = isLinear(draft.inputs);
  return (
    <div className="device-inputs-device" {...repeatedTestId('device-inputs-device', draft.deviceId)}>
      <div className="device-inputs-device-head">
        <i className="device-inputs-dot" style={{ background: deviceColor(index) }} />
        <b>{draft.label}</b>
        <span className={`device-inputs-tag device-inputs-tag--${linear ? 'count' : 'jump'}`}>
          {linear ? 'linear' : draft.inputs.length ? 'not linear' : 'no inputs'}
        </span>
        <span className="device-inputs-count">
          Inputs
          <Form.Control size="sm" type="number" min={0} value={count} aria-label="Inputs of the device"
            className="device-inputs-number" onChange={(event) => setCount(event.target.value)}
            onBlur={commitCount}
            onKeyDown={(event) => event.key === 'Enter' && commitCount()}
            {...repeatedTestId('device-inputs-count', draft.deviceId)} />
        </span>
      </div>
      {segmentsOf(draft.inputs).map((segment) => (
        <SegmentRow
          // A new key per content: the fields start from the section again.
          key={`${segment.from}-${segment.to}-${segment.start}-${segment.direction}`}
          segment={segment}
          deviceId={draft.deviceId}
          doubled={doubled}
          onApply={(from, to, start, direction) =>
            onChange(withRun(withRun(draft, segment.from, segment.to, null), from, to, start, direction))}
        />
      ))}
      <NewSegmentRow
        deviceId={draft.deviceId}
        next={draft.inputs.length + 1}
        onAdd={(from, to, start, direction) => onChange(withRun(draft, from, to, start, direction))}
      />
    </div>
  );
};

type DeviceInputsStepProps = {
  locationId: number | null;
  /** Changes when the wizard reloads the location (an import, a Klemmliste). */
  reloadKey?: number;
  /** After saving: the points' devices changed. */
  onSaved?: () => void;
};

/**
 * Step 8 of the Lageplan wizard: which sensor each input of the location's
 * devices measures (backend measure_points/device_inputs). The overview on
 * top, below per device its sections - "inputs 290-293 measure sensors from
 * 569 on, ascending", or free. A Klemmliste fills them for all devices.
 */
const DeviceInputsStep = ({ locationId, reloadKey = 0, onSaved }: DeviceInputsStepProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [answer, setAnswer] = useState<DeviceInputsAnswer | null>(null);
  const [drafts, setDrafts] = useState<InputsDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Saving with measure points no input measures asks first.
  const [confirmIncomplete, setConfirmIncomplete] = useState(false);

  const show = (data: unknown) => {
    const loaded = asAnswer(data);
    setAnswer(loaded);
    setDrafts(loaded ? draftsFrom(loaded) : []);
  };

  useEffect(() => {
    if (locationId === null) {
      show(null);
      return;
    }
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `${URL}?location_id=${locationId}`,
      (response) => {
        show(response?.data);
        setLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not load the device inputs', error);
        setLoading(false);
      },
    );
    // auth changes with the path - the location and reloads decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, reloadKey]);

  const sensors = answer?.sensors ?? [];
  const { missing, doubled } = coverage(drafts, sensors);
  const doubledSet = new Set(doubled);
  const dirty = isDirty(drafts, answer);

  const save = () => {
    if (locationId === null) {
      return;
    }
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      URL,
      savePayload(locationId, drafts),
      (response) => {
        show(response?.data);
        setSaving(false);
        showSuccessBar(enqueueSnackbar,
          `Device inputs saved - ${Number(response?.data?.connected ?? 0)} measure point(s) on their devices.`);
        onSaved?.();
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not save the device inputs', error);
        setSaving(false);
      },
    );
  };

  return (
    <StepCard
      number={8}
      step="devices"
      title="Device"
      done={drafts.length > 0 && !dirty && missing.length === 0 && doubled.length === 0}
      actions={
        locationId !== null && (
          <>
            <span className="lageplan-muted" data-testid="device-inputs-summary">
              {drafts.length} device(s) · {sensors.length} sensor(s)
              {sensors.length > 0 && missing.length === 0 && doubled.length === 0 ? ' · all assigned' : ''}
              {missing.length > 0 ? ` · ${missing.length} without input` : ''}
            </span>
            {drafts.length > 0 && (
              <PillButton
                icon={saving ? <Spinner size="sm" animation="border" /> : <Save size={13} />}
                label="Save"
                variant={dirty ? 'accent' : undefined}
                title="Save which sensor each input measures - and connect the points to their devices"
                onClick={() => (missing.length ? setConfirmIncomplete(true) : save())}
                disabled={saving || !dirty || doubled.length > 0}
                testId="device-inputs-save"
              />
            )}
          </>
        )
      }
    >
      {locationId === null ? (
        <Notice tone="warning" testId="device-inputs-need-location">
          Select a location in step 1 first.
        </Notice>
      ) : loading && !answer ? (
        <Spinner size="sm" animation="border" data-testid="device-inputs-loading" />
      ) : drafts.length === 0 ? (
        <Notice testId="device-inputs-no-devices">
          No devices are connected to this location - the points are imported without device.
        </Notice>
      ) : (
        <div className="device-inputs" data-testid="device-inputs">
          <div className="lageplan-muted lageplan-muted--small">
            Which sensor each input of the devices measures. A Klemmliste fills this for all devices - its units go
            to the devices whose MUX boards fit them. Correct it here in sections; free inputs measure nothing.
          </div>
          <div className="device-inputs-chips">
            {drafts.map((draft, index) => (
              <span key={draft.deviceId} className="device-inputs-chip">
                <i className="device-inputs-dot" style={{ background: deviceColor(index) }} />
                <b>{draft.label}</b> · {draft.inputs.filter((sensor) => sensor != null).length} sensor(s)
              </span>
            ))}
          </div>
          <DeviceInputsOverview drafts={drafts} sensors={sensors} />
          {missing.length > 0 && (
            <Notice tone="warning" testId="device-inputs-missing">
              {missing.length} measure point(s) are measured by no input: {numberRanges(missing)}
            </Notice>
          )}
          {doubled.length > 0 && (
            <Notice tone="danger" testId="device-inputs-doubled">
              Sensor(s) on two inputs - fix them before saving: {numberRanges(doubled)}
            </Notice>
          )}
          <ConfirmDialog
            testId="device-inputs-incomplete"
            show={confirmIncomplete}
            title="Save an incomplete assignment?"
            message={
              <>
                <b>{missing.length} measure point(s)</b> are measured by no input:{' '}
                <b>{numberRanges(missing)}</b>. They stay without device - and without readings - until an input
                measures them. Save anyway?
              </>
            }
            confirmLabel="Save anyway"
            cancelLabel="Keep editing"
            danger={false}
            onCancel={() => setConfirmIncomplete(false)}
            onConfirm={() => {
              setConfirmIncomplete(false);
              save();
            }}
          />
          {drafts.map((draft, index) => (
            <DeviceSections
              key={draft.deviceId}
              draft={draft}
              index={index}
              doubled={doubledSet}
              onChange={(next) =>
                setDrafts((current) => current.map((item) => (item.deviceId === next.deviceId ? next : item)))}
            />
          ))}
        </div>
      )}
    </StepCard>
  );
};

export default DeviceInputsStep;
