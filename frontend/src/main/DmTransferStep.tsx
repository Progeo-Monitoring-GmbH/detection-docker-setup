import { useEffect, useMemo, useState } from 'react';
import { Form, Spinner } from 'react-bootstrap';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { enqueueSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { getBackendUrl } from '../backendUrl';
import PillButton from '../components/ui/kit/PillButton';
import { progeoTableStyles } from '../components/ui/kit/SearchableDataTable';
import { repeatedTestId } from '../testIds';
import { useLatestRef } from '../components/ui/useLatestRef';
import { requestReason } from './lageplanWizardUtils';
import './DmTransferStep.css';

/**
 * "dm-Transfer" (optional step of the Lageplan wizard): the band ends of
 * smartex dm sensors read from the orange lines of the plan
 * (backend helper/dm_transfer.py). "Detect bands" follows the band each
 * measure point lies on and shows the proposals over the plan; "Store"
 * saves the chosen ones (nx/ny -> nx_end/ny_end).
 */

export type BandStatus = 'found' | 'shared' | 'unclear' | 'no_line';

export type BandProposal = {
  id: number;
  sensor_order: number;
  name: string | null;
  status: BandStatus;
  /** The point had a band end already. */
  had_end: boolean;
  nx: number | null;
  ny: number | null;
  nx_end: number | null;
  ny_end: number | null;
  /** Image fractions, for the preview. */
  start: [number, number] | null;
  end: [number, number] | null;
  /** Share of the plan's longest side. */
  length: number | null;
};

const STATUS_LABELS: Record<BandStatus, string> = {
  found: 'Found',
  shared: 'Split by guess',
  unclear: 'Unclear',
  no_line: 'No line',
};

const STATUSES: BandStatus[] = ['found', 'shared', 'unclear', 'no_line'];

/** The proposals to store: bands found (and, if wanted, the guessed splits),
 * only for points without an end unless existing ends are replaced. */
export const bandsToStore = (
  proposals: BandProposal[],
  { includeShared, replaceExisting }: { includeShared: boolean; replaceExisting: boolean },
) =>
  proposals.filter(
    (proposal) =>
      (proposal.status === 'found' || (includeShared && proposal.status === 'shared')) &&
      (replaceExisting || !proposal.had_end) &&
      proposal.nx !== null &&
      proposal.nx_end !== null,
  );

export const countByStatus = (proposals: BandProposal[]) =>
  Object.fromEntries(
    STATUSES.map((status) => [status, proposals.filter((proposal) => proposal.status === status).length]),
  ) as Record<BandStatus, number>;

/** The plan image - media needs the Authorization header, so it is fetched as blob. */
export const usePlanImage = (url: string | null | undefined) => {
  const auth = useAuth();
  const authRef = useLatestRef(auth);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      return undefined;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void axiosConfig.perform_get(
      authRef.current,
      getBackendUrl(url),
      (response) => {
        if (!cancelled) {
          objectUrl = URL.createObjectURL(response.data as Blob);
          setSrc(objectUrl);
        }
      },
      () => undefined,
      { responseType: 'blob' },
    );
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [url, authRef]);
  return src;
};

/** The proposals drawn over the plan: found bands solid, guessed splits dashed, the start as dot. */
const BandPreview = ({
  imageUrl,
  proposals,
  highlighted,
}: {
  imageUrl: string | null | undefined;
  proposals: BandProposal[];
  highlighted: number | null;
}) => {
  const src = usePlanImage(imageUrl);
  const [aspect, setAspect] = useState<number | null>(null);
  if (!src) {
    return (
      <div className="dm-transfer-preview dm-transfer-preview--loading">
        <Spinner animation="border" size="sm" />
      </div>
    );
  }
  return (
    <div className="dm-transfer-preview" data-testid="dm-transfer-preview">
      <img
        src={src}
        alt=""
        onLoad={(event) => setAspect(event.currentTarget.naturalHeight / event.currentTarget.naturalWidth)}
      />
      {aspect !== null && (
        <svg viewBox={`0 0 1000 ${1000 * aspect}`} preserveAspectRatio="none" aria-hidden="true">
          {proposals.map((proposal) =>
            proposal.start && proposal.end ? (
              <g
                key={proposal.id}
                className={[
                  'dm-transfer-band',
                  `dm-transfer-band--${proposal.status}`,
                  highlighted === proposal.id ? 'dm-transfer-band--highlighted' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <line
                  x1={proposal.start[0] * 1000}
                  y1={proposal.start[1] * 1000 * aspect}
                  x2={proposal.end[0] * 1000}
                  y2={proposal.end[1] * 1000 * aspect}
                />
                <circle cx={proposal.start[0] * 1000} cy={proposal.start[1] * 1000 * aspect} r={4} />
              </g>
            ) : null,
          )}
        </svg>
      )}
    </div>
  );
};

const DmTransferStep = ({
  locationId,
  plan,
  pointCount,
  pointsWithEnd,
  canEdit,
  onStored,
}: {
  /** The location's project id (the measure_points endpoints' location_id). */
  locationId: number | null;
  plan: { id: number; url?: string | null } | null;
  /** Measure points on the plan, and how many of them are bands already. */
  pointCount: number;
  pointsWithEnd: number;
  canEdit: boolean;
  onStored: () => void;
}) => {
  const auth = useAuth();
  const [proposals, setProposals] = useState<BandProposal[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [storing, setStoring] = useState(false);
  const [error, setError] = useState('');
  const [includeShared, setIncludeShared] = useState(true);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);

  // Another plan: the proposals were for the old one.
  const planId = plan?.id ?? null;
  const [proposalsPlan, setProposalsPlan] = useState<number | null>(null);
  const shown = proposalsPlan === planId ? proposals : null;

  const toStore = useMemo(
    () => (shown ? bandsToStore(shown, { includeShared, replaceExisting }) : []),
    [shown, includeShared, replaceExisting],
  );
  const counts = useMemo(() => countByStatus(shown ?? []), [shown]);

  const detect = () => {
    if (locationId === null || planId === null) {
      return;
    }
    setDetecting(true);
    setError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/dm_transfer/',
      { location_id: locationId, lageplan_id: planId },
      (response) => {
        setProposals((response?.data?.proposals ?? []) as BandProposal[]);
        setProposalsPlan(planId);
        setDetecting(false);
      },
      (requestError) => {
        setError(`Could not detect the bands: ${requestReason(requestError)}`);
        setDetecting(false);
      },
    );
  };

  const store = () => {
    if (locationId === null || planId === null || !toStore.length) {
      return;
    }
    setStoring(true);
    setError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/dm_transfer/apply/',
      {
        location_id: locationId,
        lageplan_id: planId,
        points: toStore.map(({ id, nx, ny, nx_end, ny_end }) => ({ id, nx, ny, nx_end, ny_end })),
      },
      (response) => {
        const stored = Number(response?.data?.stored ?? toStore.length);
        enqueueSnackbar(`${stored} band(s) stored.`, { variant: 'success' });
        setStoring(false);
        setProposals(null);
        onStored();
      },
      (requestError) => {
        setError(`Could not store the bands: ${requestReason(requestError)}`);
        setStoring(false);
      },
    );
  };

  const columns = useMemo<TableColumn<BandProposal>[]>(
    () => [
      {
        id: 'sensor',
        name: 'Sensor',
        selector: (row) => row.sensor_order,
        sortable: true,
        cell: (row) => (
          <span {...repeatedTestId('dm-transfer-row', row.id)}>
            {row.sensor_order}
            {row.name ? <span className="lageplan-muted"> · {row.name}</span> : null}
          </span>
        ),
      },
      {
        id: 'status',
        name: 'Band',
        selector: (row) => STATUSES.indexOf(row.status),
        sortable: true,
        cell: (row) => (
          <span className={`dm-transfer-status dm-transfer-status--${row.status}`}>{STATUS_LABELS[row.status]}</span>
        ),
      },
      {
        id: 'length',
        name: 'Length',
        selector: (row) => row.length ?? -1,
        sortable: true,
        right: true,
        format: (row) => (row.length !== null ? `${Math.round(row.length * 100)} %` : '–'),
      },
      {
        id: 'had-end',
        name: 'Had an end',
        selector: (row) => Number(row.had_end),
        sortable: true,
        format: (row) => (row.had_end ? 'yes' : '–'),
      },
    ],
    [],
  );

  if (!plan?.url) {
    return (
      <div className="lageplan-notice lageplan-notice--warning" data-testid="dm-transfer-needs-plan">
        Select or add a Lageplan in step 2 first.
      </div>
    );
  }

  return (
    <div className="dm-transfer" data-testid="dm-transfer">
      <div className="lageplan-muted">
        Optional, for smartex dm plans whose sensors are points without their band end: follows the orange band
        each measure point lies on to both of its ends - the end nearer the point becomes the start. Uses the
        alignment saved in step 4, so the points must lie on their bands there.
      </div>
      <div className="dm-transfer-actions">
        <span className="lageplan-muted" data-testid="dm-transfer-point-count">
          {pointCount} measure point(s) on this plan · {pointCount - pointsWithEnd} without band end
        </span>
        <PillButton
          label={detecting ? 'Detecting…' : 'Detect bands'}
          icon={detecting ? <Spinner size="sm" animation="border" /> : undefined}
          onClick={detect}
          disabled={detecting || !pointCount || locationId === null}
          testId="dm-transfer-detect"
        />
      </div>
      {error && (
        <div className="lageplan-notice lageplan-notice--danger" data-testid="dm-transfer-error">
          {error}
        </div>
      )}

      {shown && (
        <>
          <div className="dm-transfer-counts" data-testid="dm-transfer-counts">
            {STATUSES.filter((status) => counts[status] > 0).map((status) => (
              <span key={status} className={`dm-transfer-status dm-transfer-status--${status}`}>
                {STATUS_LABELS[status]}: {counts[status]}
              </span>
            ))}
          </div>
          {counts.shared > 0 && (
            <div className="lageplan-muted">
              Split by guess (dashed): two points lie on one continuous line - it was split between them. Check
              these in the preview.
            </div>
          )}
          <BandPreview imageUrl={plan.url} proposals={shown} highlighted={highlighted} />
          <div onMouseLeave={() => setHighlighted(null)}>
            <DataTable
              columns={columns}
              data={shown}
              keyField="id"
              customStyles={progeoTableStyles}
              dense
              highlightOnHover
              pagination={shown.length > 15}
              paginationPerPage={15}
              defaultSortFieldId="sensor"
              onRowMouseEnter={(row) => setHighlighted(row.id)}
            />
          </div>
          <div className="dm-transfer-actions">
            <Form.Check
              id="dm-transfer-include-shared"
              type="switch"
              label="Store the bands split by guess"
              checked={includeShared}
              onChange={(event) => setIncludeShared(event.target.checked)}
              data-testid="dm-transfer-include-shared"
            />
            <Form.Check
              id="dm-transfer-replace"
              type="switch"
              label="Replace existing band ends"
              checked={replaceExisting}
              onChange={(event) => setReplaceExisting(event.target.checked)}
              data-testid="dm-transfer-replace"
            />
            <PillButton
              variant="accent"
              label={storing ? 'Storing…' : `Store ${toStore.length} band(s)`}
              onClick={store}
              disabled={!canEdit || storing || !toStore.length}
              title={canEdit ? undefined : 'Storing needs the permission to edit devices.'}
              testId="dm-transfer-store"
            />
          </div>
        </>
      )}
    </div>
  );
};

export default DmTransferStep;
