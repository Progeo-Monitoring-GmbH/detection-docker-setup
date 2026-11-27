import {
  type CSSProperties,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { Alert, Button, Form, Modal, Spinner } from 'react-bootstrap';
import {
  ArrowClockwise,
  ArrowCounterclockwise,
  CheckCircleFill,
  ExclamationTriangleFill,
  Trash,
} from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { errorReason } from '../../components/ui/Snackbar.jsx';
import { useLatestRef } from '../../components/ui/useLatestRef';
import { useRequest } from '../../hooks/useRequest';
import PanelCard from '../../components/ui/kit/PanelCard';
import PillButton from '../../components/ui/kit/PillButton';
import SearchableDataTable, {
  progeoTableStyles,
  type SearchableColumn,
} from '../../components/ui/kit/SearchableDataTable';
import SegmentedControl from '../../components/ui/kit/SegmentedControl';
import { formatDate } from '../dateFormat';
import './StaffInsights.css';
import './ThresholdFineTuneView.css';

const URL = '/v1/threshold-fine-tune/';

type Action =
  'lower' | 'raise' | 'keep' | 'review' | 'no_data' | 'skipped_active_alarm';
const ACTIONS: Action[] = [
  'lower',
  'raise',
  'review',
  'keep',
  'skipped_active_alarm',
  'no_data',
];

/** One location of a findings file (helper/threshold_fine_tune.py, read_file). */
export type FineTuneEntry = {
  key: string;
  location_id: number;
  project_id: number | null;
  name: string | null;
  current_threshold: number;
  /** The location's threshold now (null: the location is gone). */
  live_threshold: number | null;
  max_value: number | null;
  max_at: {
    value: number;
    sensor_order: number;
    device_id: number;
    at: string;
  } | null;
  action: Action;
  proposed: number | null;
  change_percent: number | null;
  measurements: number;
  excluded_sensors: number[];
  active_alarms: number;
  warnings: string[];
  /** Set once the staff page applied a threshold from this file. */
  applied?: { at: string; by: string | null; old: number; new: number };
  scan_proposal?: {
    action: Action;
    proposed: number | null;
    change_percent: number | null;
  };
};

type Findings = {
  file: string;
  created_at: string;
  params: {
    days: number;
    buffer_percent: number;
    minimum: number;
    max_raise_percent: number;
    step_minutes: number | null;
    projects: number[] | null;
  };
  summary: Partial<Record<Action, number>>;
  locations: FineTuneEntry[];
  /** Why the file can no longer be applied (too old), else null. */
  stale: string | null;
};

type FileInfo = {
  file: string;
  created_at: string;
  locations: number;
  applied: number;
};
type ApplyResult = {
  applied: Array<{
    name: string | null;
    project_id: number | null;
    old: number;
    new: number;
  }>;
  skipped: Array<{ key: string; name: string | null; reason: string }>;
};
type Filter = 'all' | 'applied' | Action;

/** The threshold the location should have now: the scanned one, or the one applied from this file. */
const expectedThreshold = (entry: FineTuneEntry) =>
  entry.applied?.new ?? entry.current_threshold;

/** Where the slider starts: the proposal, else the threshold now. */
export const initialThreshold = (entry: FineTuneEntry) =>
  entry.proposed ?? expectedThreshold(entry);

/** Safety margin of `threshold` above the true maximum, in percent (null: no data). */
export const safetyMargin = (threshold: number, maximum: number | null) =>
  maximum == null || maximum <= 0
    ? null
    : ((threshold - maximum) / maximum) * 100;

/** The slider's range: wide enough for the maximum, the threshold now and the proposal. */
export const sliderRange = (entry: FineTuneEntry) => {
  const values = [
    entry.max_value,
    entry.current_threshold,
    entry.proposed,
    entry.applied?.new,
  ].filter((value): value is number => value != null && value > 0);
  return {
    min: Math.max(1, Math.floor(Math.min(...values) * 0.5)),
    max: Math.max(10, Math.ceil(Math.max(...values) * 1.6)),
  };
};

/** Where `value` sits on the slider of `range`, 0..1. */
export const sliderPosition = (
  value: number,
  range: { min: number; max: number },
) =>
  (Math.min(range.max, Math.max(range.min, value)) - range.min) /
  (range.max - range.min);

/** Labels nearer than this (part of the track) share no row. */
const LABEL_GAP = 0.1;

type SliderMark = {
  kind: 'max' | 'current' | 'proposed';
  value: number;
  position: number;
  row: 0 | 1;
};

/**
 * The marks on a location's slider: the true maximum (red), the threshold
 * it has now (orange) and the proposal (green), left to right. A label too
 * near the one before it moves to a second row.
 */
export const sliderMarks = (
  entry: FineTuneEntry,
  range: { min: number; max: number },
): SliderMark[] => {
  const marks = (
    [
      ['max', entry.max_value],
      ['current', expectedThreshold(entry)],
      ['proposed', entry.proposed],
    ] as const
  )
    .filter(
      (mark): mark is readonly [SliderMark['kind'], number] =>
        mark[1] != null && mark[1] > 0,
    )
    .map(([kind, value]) => ({
      kind,
      value,
      position: sliderPosition(value, range),
      row: 0 as 0 | 1,
    }))
    .sort((a, b) => a.position - b.position);
  let last = -1;
  marks.forEach((mark) => {
    mark.row = last >= 0 && mark.position - last < LABEL_GAP ? 1 : 0;
    if (mark.row === 0) {
      last = mark.position;
    }
  });
  return marks;
};

/** "danger" below the maximum, "warn" below the scan's buffer, else "ok". */
export const marginLevel = (margin: number | null, bufferPercent: number) =>
  margin == null
    ? 'none'
    : margin < 0
      ? 'danger'
      : margin < bufferPercent
        ? 'warn'
        : 'ok';

const formatMargin = (margin: number | null) =>
  margin == null
    ? '–'
    : `${margin >= 0 ? '+' : ''}${margin.toFixed(margin > -10 && margin < 10 ? 1 : 0)} %`;

/** The picked thresholds - read by the cells, so the columns stay stable while sliding. */
type Choices = {
  chosen: Record<string, number>;
  choose: (entry: FineTuneEntry, value: number) => void;
  buffer: number;
};
const ChoiceContext = createContext<Choices>({
  chosen: {},
  choose: () => undefined,
  buffer: 25,
});

const chosenOf = (chosen: Record<string, number>, entry: FineTuneEntry) =>
  chosen[entry.key] ?? initialThreshold(entry);

const ThresholdCell = ({ entry }: { entry: FineTuneEntry }) => {
  const { t } = useTranslation();
  const { chosen, choose, buffer } = useContext(ChoiceContext);
  const value = chosenOf(chosen, entry);
  const range = sliderRange(entry);
  const marks = sliderMarks(entry, range);
  // Below the maximum the location would alarm; up to the buffer above it is the safety margin.
  const unsafeEnd =
    entry.max_value != null ? sliderPosition(entry.max_value, range) : 0;
  const bufferEnd =
    entry.max_value != null
      ? sliderPosition(entry.max_value * (1 + buffer / 100), range)
      : 0;
  const markTitle = (mark: SliderMark) =>
    `${t(mark.kind === 'max' ? 'ftt_col_max' : mark.kind === 'current' ? 'ftt_col_current' : 'ftt_col_proposed')}: ${mark.value}`;
  const changed = value !== expectedThreshold(entry);
  const set = (raw: string) => {
    const next = Math.round(Number(raw));
    if (Number.isFinite(next) && next >= 1) {
      choose(entry, next);
    }
  };
  return (
    <div
      className="ftt-threshold"
      data-testid="ftt-threshold"
      data-test-key={entry.key}
    >
      <div className="ftt-rail">
        <div className="ftt-track">
          {unsafeEnd > 0 && (
            <i
              className="ftt-zone ftt-zone--unsafe"
              style={{ width: `${unsafeEnd * 100}%` }}
              title={t('ftt_zone_unsafe', { max: entry.max_value })}
              data-testid="ftt-zone-unsafe"
            />
          )}
          {bufferEnd > unsafeEnd && (
            <i
              className="ftt-zone ftt-zone--buffer"
              style={{
                left: `${unsafeEnd * 100}%`,
                width: `${(bufferEnd - unsafeEnd) * 100}%`,
              }}
              title={t('ftt_zone_buffer', { buffer })}
              data-testid="ftt-zone-buffer"
            />
          )}
        </div>
        {marks.map((mark) => (
          <span
            key={mark.kind}
            className={`ftt-mark ftt-mark--${mark.kind}${mark.row ? ' ftt-mark--low' : ''}`}
            style={{ '--ftt-at': mark.position } as CSSProperties}
            title={markTitle(mark)}
            data-testid="ftt-mark"
            data-test-key={mark.kind}
          >
            <span className="ftt-mark-value">{mark.value}</span>
            <i className="ftt-mark-tick" />
          </span>
        ))}
        <Form.Range
          min={range.min}
          max={range.max}
          step={1}
          value={Math.min(range.max, Math.max(range.min, value))}
          onChange={(event) => set(event.target.value)}
          aria-label={t('ftt_col_new')}
          className="ftt-slider"
          data-testid="ftt-slider"
        />
      </div>
      <Form.Control
        type="number"
        size="sm"
        min={1}
        value={value}
        onChange={(event) => set(event.target.value)}
        className={changed ? 'ftt-number ftt-number--changed' : 'ftt-number'}
        aria-label={t('ftt_col_new')}
        data-testid="ftt-number"
      />
    </div>
  );
};

const MarginCell = ({ entry }: { entry: FineTuneEntry }) => {
  const { t } = useTranslation();
  const { chosen, buffer } = useContext(ChoiceContext);
  const value = chosenOf(chosen, entry);
  const margin = safetyMargin(value, entry.max_value);
  const level = marginLevel(margin, buffer);
  return (
    <span
      className={`ftt-margin ftt-margin--${level}`}
      title={
        entry.max_value == null
          ? t('ftt_margin_no_data')
          : t('ftt_margin_hint', { value, max: entry.max_value })
      }
      data-testid="ftt-margin"
      data-test-key={entry.key}
    >
      <span className="fw-bold">{formatMargin(margin)}</span>
      {entry.max_value != null && (
        <span className="ftt-margin-abs">
          {value - entry.max_value >= 0 ? '+' : ''}
          {value - entry.max_value}
        </span>
      )}
    </span>
  );
};

const ActionBadge = ({ entry }: { entry: FineTuneEntry }) => {
  const { t } = useTranslation();
  const action = entry.scan_proposal?.action ?? entry.action;
  return (
    <span className="d-inline-flex flex-column gap-1">
      <span className={`ftt-action ftt-action--${action}`}>
        {t(`ftt_action_${action}`)}
      </span>
      {entry.applied && (
        <span
          className="ftt-applied"
          title={t('ftt_applied_hint', {
            at: formatDate(entry.applied.at, 'dateTime'),
            by: entry.applied.by ?? '–',
            old: entry.applied.old,
            new: entry.applied.new,
          })}
        >
          <CheckCircleFill aria-hidden /> {t('ftt_applied')}
        </span>
      )}
    </span>
  );
};

/** A value column's header with the colour of its mark on the slider (legend). */
const ValueHead = ({
  kind,
  label,
}: {
  kind: SliderMark['kind'];
  label: string;
}) => (
  <span className="ftt-value-head">
    <i className={`ftt-swatch ftt-value--${kind}`} aria-hidden />
    {label}
  </span>
);

const CurrentCell = ({ entry }: { entry: FineTuneEntry }) => {
  const { t } = useTranslation();
  const expected = expectedThreshold(entry);
  const drift = entry.live_threshold !== expected;
  return (
    <span className="small staff-insights-num">
      <span className="fw-bold ftt-value ftt-value--current">{expected}</span>
      {entry.applied && (
        <span className="text-muted">
          {' '}
          ({t('ftt_scanned', { value: entry.current_threshold })})
        </span>
      )}
      {drift && (
        <span
          className="ftt-drift"
          title={t('ftt_drift_hint')}
          data-testid="ftt-drift"
        >
          <ExclamationTriangleFill aria-hidden />{' '}
          {entry.live_threshold == null
            ? t('ftt_gone')
            : t('ftt_now', { value: entry.live_threshold })}
        </span>
      )}
    </span>
  );
};

const ConfirmApplyModal = ({
  rows,
  busy,
  onConfirm,
  onHide,
}: {
  rows: Array<{ entry: FineTuneEntry; value: number }> | null;
  busy: boolean;
  onConfirm: () => void;
  onHide: () => void;
}) => {
  const { t } = useTranslation();
  const { buffer } = useContext(ChoiceContext);
  return (
    <Modal show={rows != null} onHide={onHide} data-testid="ftt-apply-modal">
      <Modal.Header closeButton>
        <Modal.Title as="h5">
          {t('ftt_apply_title', { count: rows?.length ?? 0 })}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ul className="ftt-change-list">
          {(rows ?? []).map(({ entry, value }) => {
            const margin = safetyMargin(value, entry.max_value);
            return (
              <li
                key={entry.key}
                data-testid="ftt-apply-row"
                data-test-key={entry.key}
              >
                <span className="fw-bold">
                  {entry.project_id != null && `#${entry.project_id} `}
                  {entry.name ?? '–'}
                </span>
                <span className="staff-insights-num">
                  <span className="fw-bold">{expectedThreshold(entry)}</span> →{' '}
                  <span className="fw-bold">{value}</span>
                  <span
                    className={`ftt-margin ftt-margin--${marginLevel(margin, buffer)} ms-2`}
                  >
                    {t('ftt_margin_short', { margin: formatMargin(margin) })}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        <div className="small text-muted">{t('ftt_apply_note')}</div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onHide} disabled={busy}>
          {t('ftt_cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={onConfirm}
          disabled={busy}
          data-testid="ftt-apply-confirm"
        >
          {busy && <Spinner animation="border" size="sm" className="me-1" />}
          {t('ftt_apply_confirm', { count: rows?.length ?? 0 })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

const ConfirmRemoveModal = ({
  rows,
  busy,
  onConfirm,
  onHide,
}: {
  rows: FineTuneEntry[] | null;
  busy: boolean;
  onConfirm: () => void;
  onHide: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <Modal show={rows != null} onHide={onHide} data-testid="ftt-remove-modal">
      <Modal.Header closeButton>
        <Modal.Title as="h5">
          {t('ftt_remove_title', { count: rows?.length ?? 0 })}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ul className="ftt-change-list">
          {(rows ?? []).map((entry) => (
            <li key={entry.key}>
              <span className="fw-bold">
                {entry.project_id != null && `#${entry.project_id} `}
                {entry.name ?? '–'}
              </span>
            </li>
          ))}
        </ul>
        <div className="small text-muted">{t('ftt_remove_note')}</div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onHide} disabled={busy}>
          {t('ftt_cancel')}
        </Button>
        <Button
          variant="danger"
          onClick={onConfirm}
          disabled={busy}
          data-testid="ftt-remove-confirm"
        >
          {busy && <Spinner animation="border" size="sm" className="me-1" />}
          {t('ftt_remove_confirm', { count: rows?.length ?? 0 })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

/**
 * Staff (Systemverwaltung, module_admin_thresholds): the findings of
 * `manage.py fine_tune_thresholds` - per location the true maximum, the
 * proposed global alarm threshold and its safety margin above the maximum.
 * The threshold is picked on a slider (the margin follows), the selected
 * rows are applied (the backend checks nothing changed since the scan), and
 * entries that shouldn't be tuned are removed from the file.
 */
const ThresholdFineTuneView = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const authRef = useLatestRef(auth);

  const [file, setFile] = useState('');
  const [error, setError] = useState<string | null>(null);
  const failed = (requestError: unknown) =>
    setError(errorReason(requestError) || 'Unknown error');
  const [filter, setFilter] = useState<Filter>('all');
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmApply, setConfirmApply] = useState<Array<{
    entry: FineTuneEntry;
    value: number;
  }> | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<FineTuneEntry[] | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  // Findings of another file start without the choices made for the last
  // one; a reload of the same file keeps them.
  const [choicesStale, setChoicesStale] = useState(false);
  // Another file drops the last apply result and the error (adjusted during
  // render); useRequest loads its findings.
  const [seenFile, setSeenFile] = useState(file);
  if (seenFile !== file) {
    setSeenFile(file);
    setResult(null);
    if (file) {
      setError(null);
      setChoicesStale(true);
    }
  }

  // The findings files, newest first; the picked one stays while it exists.
  const {
    data: files,
    reload: loadFiles,
    setData: setFiles,
  } = useRequest<FileInfo[]>(URL, {
    auth,
    transform: (body) => (body?.files ?? []) as FileInfo[],
    onSuccess: (list) =>
      setFile((current) =>
        current && list.some((item) => item.file === current)
          ? current
          : (list[0]?.file ?? ''),
      ),
    onError: (requestError) => {
      setFiles([]);
      failed(requestError);
    },
  });

  const {
    data: findings,
    loading,
    reload: reloadFindings,
    setData: setFindings,
  } = useRequest<Findings>(file ? `${URL}${encodeURIComponent(file)}/` : null, {
    auth,
    transform: (body) => body?.findings as Findings,
    onSuccess: () => {
      if (choicesStale) {
        setChoicesStale(false);
        setChosen({});
        setSelected(new Set());
      }
    },
    onError: (requestError) => {
      setFindings(null);
      failed(requestError);
    },
  });
  // The same file again (after apply/remove, Reload): the choices stay.
  const loadFindings = () => {
    setError(null);
    return reloadFindings();
  };

  const post = useCallback(
    (url: string, body: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        void axiosConfig.perform_post(
          authRef.current,
          url,
          body,
          (response) => resolve(response?.data ?? {}),
          reject,
        );
      }),
    [authRef],
  );

  const choose = useCallback((entry: FineTuneEntry, value: number) => {
    setChosen((current) => ({ ...current, [entry.key]: value }));
    // Moving the slider selects the row - "apply selected" takes it along.
    setSelected((current) =>
      current.has(entry.key) ? current : new Set(current).add(entry.key),
    );
  }, []);
  const buffer = findings?.params.buffer_percent ?? 25;
  const choices = useMemo(
    () => ({ chosen, choose, buffer }),
    [chosen, choose, buffer],
  );

  const entries = useMemo(() => findings?.locations ?? [], [findings]);
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: entries.length, applied: 0 };
    entries.forEach((entry) => {
      const action = entry.scan_proposal?.action ?? entry.action;
      result[action] = (result[action] ?? 0) + 1;
      if (entry.applied) {
        result.applied += 1;
      }
    });
    return result;
  }, [entries]);
  const shown = useMemo(
    () =>
      filter === 'all'
        ? entries
        : filter === 'applied'
          ? entries.filter((entry) => entry.applied)
          : entries.filter(
              (entry) =>
                (entry.scan_proposal?.action ?? entry.action) === filter,
            ),
    [entries, filter],
  );
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.key)),
    [entries, selected],
  );
  const changes = useMemo(
    () =>
      selectedEntries
        .map((entry) => ({ entry, value: chosenOf(chosen, entry) }))
        .filter(({ entry, value }) => value !== expectedThreshold(entry)),
    [selectedEntries, chosen],
  );

  const apply = async () => {
    if (!confirmApply || !findings) {
      return;
    }
    setBusy(true);
    try {
      const thresholds = Object.fromEntries(
        confirmApply.map(({ entry, value }) => [entry.key, value]),
      );
      const data = await post(
        `${URL}${encodeURIComponent(findings.file)}/apply/`,
        { thresholds },
      );
      setResult({
        applied: (data.applied ?? []) as ApplyResult['applied'],
        skipped: (data.skipped ?? []) as ApplyResult['skipped'],
      });
      setConfirmApply(null);
      setSelected(new Set());
      setChosen({});
      await Promise.all([loadFindings(), loadFiles()]);
    } catch (requestError) {
      setConfirmApply(null);
      failed(requestError);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmRemove || !findings) {
      return;
    }
    setBusy(true);
    try {
      await post(`${URL}${encodeURIComponent(findings.file)}/remove/`, {
        keys: confirmRemove.map((entry) => entry.key),
      });
      setConfirmRemove(null);
      setSelected(new Set());
      await Promise.all([loadFindings(), loadFiles()]);
    } catch (requestError) {
      setConfirmRemove(null);
      failed(requestError);
    } finally {
      setBusy(false);
    }
  };

  const resetChoices = () => {
    setChosen({});
  };

  const columns: SearchableColumn<FineTuneEntry>[] = useMemo(
    () => [
      {
        id: 'location',
        name: t('ftt_col_location'),
        selector: (entry) => entry.name ?? '',
        sortable: true,
        // Narrow: the name truncates (full name on hover), the slider gets the room.
        grow: 1,
        minWidth: '130px',
        cell: (entry) => (
          <div className="small">
            <div
              className="fw-bold text-truncate"
              title={entry.name ?? undefined}
            >
              {entry.name ?? '–'}
            </div>
            <div className="text-muted">
              {entry.project_id != null ? `#${entry.project_id}` : '–'}
            </div>
          </div>
        ),
        searchText: (entry) => `${entry.name ?? ''} ${entry.project_id ?? ''}`,
      },
      {
        id: 'action',
        name: t('ftt_col_action'),
        selector: (entry) =>
          ACTIONS.indexOf(entry.scan_proposal?.action ?? entry.action),
        sortable: true,
        cell: (entry) => <ActionBadge entry={entry} />,
        searchText: (entry) =>
          t(`ftt_action_${entry.scan_proposal?.action ?? entry.action}`),
      },
      {
        id: 'max',
        name: <ValueHead kind="max" label={t('ftt_col_max')} />,
        selector: (entry) => entry.max_value ?? -1,
        sortable: true,
        right: true,
        cell: (entry) => (
          <span
            className="small staff-insights-num"
            title={
              entry.max_at
                ? t('ftt_max_hint', {
                    sensor: entry.max_at.sensor_order,
                    at: formatDate(entry.max_at.at, 'dateTime'),
                  })
                : undefined
            }
          >
            <span className="fw-bold ftt-value ftt-value--max">
              {entry.max_value ?? '–'}
            </span>
            {entry.max_at && (
              <span className="text-muted">
                {' '}
                · S{entry.max_at.sensor_order}
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'current',
        name: <ValueHead kind="current" label={t('ftt_col_current')} />,
        selector: (entry) => expectedThreshold(entry),
        sortable: true,
        right: true,
        cell: (entry) => <CurrentCell entry={entry} />,
      },
      {
        id: 'proposed',
        name: <ValueHead kind="proposed" label={t('ftt_col_proposed')} />,
        selector: (entry) =>
          entry.scan_proposal?.proposed ?? entry.proposed ?? -1,
        sortable: true,
        right: true,
        cell: (entry) => {
          const proposal = entry.scan_proposal ?? entry;
          return (
            <span className="small staff-insights-num">
              <span className="fw-bold ftt-value ftt-value--proposed">
                {proposal.proposed ?? '–'}
              </span>
              {proposal.change_percent != null && (
                <span className="text-muted">
                  {' '}
                  ({proposal.change_percent > 0 ? '+' : ''}
                  {proposal.change_percent} %)
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: 'threshold',
        name: t('ftt_col_new'),
        // The widest column: the slider with its marks.
        grow: 4,
        minWidth: '320px',
        cell: (entry) => <ThresholdCell entry={entry} />,
      },
      {
        id: 'margin',
        name: t('ftt_col_margin'),
        selector: (entry) =>
          safetyMargin(initialThreshold(entry), entry.max_value) ?? -1e9,
        sortable: true,
        right: true,
        cell: (entry) => <MarginCell entry={entry} />,
      },
      {
        id: 'warnings',
        name: t('ftt_col_warnings'),
        selector: (entry) => entry.warnings.length,
        sortable: true,
        grow: 1.2,
        cell: (entry) =>
          entry.warnings.length === 0 ? (
            <span className="small text-muted">–</span>
          ) : (
            <span className="ftt-warnings" title={entry.warnings.join('\n')}>
              <ExclamationTriangleFill aria-hidden /> {entry.warnings[0]}
              {entry.warnings.length > 1 && ` (+${entry.warnings.length - 1})`}
            </span>
          ),
        searchText: (entry) => entry.warnings.join(' '),
      },
    ],
    [t],
  );

  const filterOptions = [
    { value: 'all', label: t('ftt_filter_all', { count: counts.all }) },
    ...ACTIONS.filter((action) => counts[action]).map((action) => ({
      value: action,
      label: `${t(`ftt_action_${action}`)} (${counts[action]})`,
    })),
    ...(counts.applied
      ? [{ value: 'applied', label: `${t('ftt_applied')} (${counts.applied})` }]
      : []),
  ];

  const params = findings?.params;

  return (
    <ChoiceContext.Provider value={choices}>
      <div className="staff-insights" data-testid="page-threshold-fine-tune">
        <div className="staff-insights-head">
          <div>
            <h1 className="staff-insights-title">{t('ftt_title')}</h1>
            <div className="staff-insights-subtitle">
              {params
                ? t('ftt_subtitle', {
                    at: formatDate(findings.created_at, 'dateTime'),
                    days: params.days,
                    buffer: params.buffer_percent,
                    minimum: params.minimum,
                    raise: params.max_raise_percent,
                  })
                : t('ftt_intro')}
            </div>
          </div>
          <div className="d-flex flex-wrap align-items-center gap-2">
            {files && files.length > 0 && (
              <Form.Select
                size="sm"
                value={file}
                onChange={(event) => setFile(event.target.value)}
                className="ftt-file-select"
                aria-label={t('ftt_file')}
                data-testid="ftt-file"
              >
                {files.map((item) => (
                  <option key={item.file} value={item.file}>
                    {formatDate(item.created_at, 'dateTime')} ·{' '}
                    {t('ftt_file_locations', { count: item.locations })}
                    {item.applied
                      ? ` · ${t('ftt_file_applied', { count: item.applied })}`
                      : ''}
                  </option>
                ))}
              </Form.Select>
            )}
            <PillButton
              label={t('ftt_reload')}
              icon={
                loading ? (
                  <Spinner animation="border" size="sm" />
                ) : (
                  <ArrowClockwise />
                )
              }
              onClick={() => {
                void loadFiles();
                void loadFindings();
              }}
              disabled={loading}
              variant="ghost"
              testId="ftt-reload"
            />
          </div>
        </div>

        {error && (
          <Alert
            variant="danger"
            className="mb-0 small"
            dismissible
            onClose={() => setError(null)}
            data-testid="ftt-error"
          >
            {error}
          </Alert>
        )}
        {findings?.stale && (
          <Alert
            variant="warning"
            className="mb-0 small"
            data-testid="ftt-stale"
          >
            {t('ftt_stale')}{' '}
            <span className="text-muted">({findings.stale})</span>
          </Alert>
        )}
        {result && (
          <Alert
            variant={result.skipped.length ? 'warning' : 'success'}
            className="mb-0 small"
            dismissible
            onClose={() => setResult(null)}
            data-testid="ftt-result"
          >
            <div>
              {t('ftt_result_applied', { count: result.applied.length })}
            </div>
            {result.skipped.length > 0 && (
              <ul className="mb-0 mt-1">
                {result.skipped.map((item) => (
                  <li key={item.key}>
                    <span className="fw-bold">{item.name ?? item.key}</span>:{' '}
                    {item.reason}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        {files && files.length === 0 && (
          <Alert
            variant="secondary"
            className="mb-0 small"
            data-testid="ftt-no-files"
          >
            {t('ftt_no_files')}{' '}
            <code>python manage.py fine_tune_thresholds</code>
          </Alert>
        )}

        {findings && (
          <PanelCard title={t('ftt_table_title')} testId="ftt-table">
            <SearchableDataTable
              columns={columns}
              data={shown}
              keyField="key"
              columnWidthsKey="staff-thresholds"
              pagination
              paginationPerPage={50}
              paginationRowsPerPageOptions={[25, 50, 100, 500]}
              customStyles={progeoTableStyles}
              progressPending={loading}
              progressComponent={
                <div className="py-4">
                  <Spinner animation="border" size="sm" />
                </div>
              }
              noDataComponent={
                <div className="small text-muted py-3">{t('ftt_empty')}</div>
              }
              selection={{
                rowKey: (entry) => entry.key,
                selected,
                onChange: setSelected,
                toggleOnRowClick: false,
              }}
              mobileColumns={['location', 'threshold', 'margin']}
              toolbar={
                <div className="d-flex flex-wrap align-items-center gap-2">
                  <SegmentedControl
                    options={filterOptions}
                    value={filter}
                    onChange={(value) => setFilter(value as Filter)}
                    testId="ftt-filter"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={
                      changes.length === 0 || Boolean(findings.stale) || busy
                    }
                    onClick={() => setConfirmApply(changes)}
                    title={findings.stale ? t('ftt_stale') : undefined}
                    data-testid="ftt-apply"
                  >
                    {t('ftt_apply', { count: changes.length })}
                  </Button>
                  <PillButton
                    label={t('ftt_remove', { count: selectedEntries.length })}
                    icon={<Trash />}
                    onClick={() => setConfirmRemove(selectedEntries)}
                    disabled={selectedEntries.length === 0 || busy}
                    variant="ghost"
                    testId="ftt-remove"
                  />
                  {Object.keys(chosen).length > 0 && (
                    <PillButton
                      label={t('ftt_reset')}
                      icon={<ArrowCounterclockwise />}
                      onClick={resetChoices}
                      variant="ghost"
                      testId="ftt-reset"
                    />
                  )}
                </div>
              }
              testId="ftt-rows"
            />
            <div className="staff-insights-note">
              {t('ftt_note', { buffer })}
            </div>
          </PanelCard>
        )}

        <ConfirmApplyModal
          rows={confirmApply}
          busy={busy}
          onConfirm={() => void apply()}
          onHide={() => setConfirmApply(null)}
        />
        <ConfirmRemoveModal
          rows={confirmRemove}
          busy={busy}
          onConfirm={() => void remove()}
          onHide={() => setConfirmRemove(null)}
        />
      </div>
    </ChoiceContext.Provider>
  );
};

export default ThresholdFineTuneView;
