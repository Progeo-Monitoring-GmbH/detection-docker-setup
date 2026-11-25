import { useEffect, useMemo, useState } from 'react';
import { Modal, Spinner } from 'react-bootstrap';
import {
  BoxArrowUpRight,
  ExclamationTriangleFill,
} from 'react-bootstrap-icons';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showRequestError } from '../../components/ui/Snackbar.jsx';
import { progeoTableStyles } from '../../components/ui/kit/SearchableDataTable';
import { formatDate } from '../dateFormat';
import { repeatedTestId } from '../../testIds';
import {
  adminUrl,
  formatDelta,
  formatOhm,
  historyUrl,
  type FactorySensorRow,
  type SiteMeasurement,
} from './factorySensors';
import { StatusBadge } from './FactorySensorStatus';
import './FactorySensorsView.css';

type Props = {
  sensor: FactorySensorRow;
  onHide: () => void;
};

/** The site measurements of one factory sensor, newest first. */
const FactorySensorHistoryModal = ({ sensor, onHide }: Props) => {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [measurements, setMeasurements] = useState<SiteMeasurement[] | null>(
    null,
  );
  const locale = i18n.language;

  useEffect(() => {
    axiosConfig.perform_get(
      auth,
      historyUrl(sensor.id),
      (response: { data: { messungen: SiteMeasurement[] } }) =>
        setMeasurements(response.data.messungen),
      (error: unknown) => {
        setMeasurements([]);
        showRequestError(enqueueSnackbar, t('fs_load_failed'), error);
      },
    );
  }, [auth, enqueueSnackbar, sensor.id, t]);

  const columns = useMemo<TableColumn<SiteMeasurement>[]>(
    () => [
      {
        id: 'zeit',
        name: t('fs_col_zeit'),
        grow: 1.4,
        cell: (row) => (
          <span
            className="fw-bold"
            {...repeatedTestId('factory-sensor-history-row', row.id)}
          >
            {formatDate(row.zeit)}
          </span>
        ),
      },
      {
        id: 'r_ohm',
        name: t('fs_col_r_ohm'),
        selector: (row) => formatOhm(row.r_ohm, locale),
      },
      {
        id: 'delta',
        name: t('fs_col_delta'),
        cell: (row) => (
          <span className="fw-bold">
            {formatDelta(row.delta_prozent, locale)}
          </span>
        ),
      },
      {
        id: 'status',
        name: t('fs_col_status'),
        cell: (row) => <StatusBadge status={row.status} />,
      },
      {
        id: 'r_status',
        name: t('fs_col_r_status'),
        selector: (row) => t(`fs_r_status_${row.r_status}`),
      },
      {
        id: 'tag',
        name: t('fs_col_tag_uid'),
        grow: 1.4,
        cell: (row) => (
          <span className={row.tag_passt_nicht ? 'text-danger' : undefined}>
            {row.tag_passt_nicht && (
              <ExclamationTriangleFill
                className="me-1"
                title={t('fs_tag_mismatch')}
              />
            )}
            {row.tag_uid ?? '–'}
          </span>
        ),
      },
      { id: 'geraet', name: t('fs_col_geraet'), selector: (row) => row.geraet },
      {
        id: 'benutzer',
        name: t('fs_col_benutzer'),
        selector: (row) => row.benutzer ?? '–',
      },
    ],
    [locale, t],
  );

  return (
    <Modal
      show
      onHide={onHide}
      dialogClassName="fs-modal"
      data-testid="factory-sensor-history"
    >
      <Modal.Header closeButton>
        <Modal.Title>
          {t('fs_history_title', {
            projekt: sensor.projekt,
            sensor: sensor.sensor,
          })}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <dl className="fs-facts">
          <div>
            <dt>{t('fs_col_r_werk_ohm')}</dt>
            <dd className="fw-bold">{formatOhm(sensor.r_werk_ohm, locale)}</dd>
          </div>
          <div>
            <dt>{t('fs_col_band')}</dt>
            <dd className="fw-bold">{sensor.band ?? '–'}</dd>
          </div>
          <div>
            <dt>{t('fs_col_tag_uid')}</dt>
            <dd className="fw-bold">{sensor.tag_uid ?? '–'}</dd>
          </div>
          <div>
            <dt>{t('fs_col_gemessen_am')}</dt>
            <dd className="fw-bold">
              {sensor.gemessen_am ? formatDate(sensor.gemessen_am) : '–'}
            </dd>
          </div>
          <div className="fs-facts-link">
            <a href={adminUrl(sensor.id)} target="_blank" rel="noreferrer">
              {t('fs_admin_edit')} <BoxArrowUpRight size={11} />
            </a>
          </div>
        </dl>
        {measurements === null ? (
          <Spinner size="sm" />
        ) : (
          <DataTable
            columns={columns}
            data={measurements}
            customStyles={progeoTableStyles}
            dense
            noDataComponent={
              <div className="progeo-table-empty">{t('fs_history_empty')}</div>
            }
          />
        )}
      </Modal.Body>
    </Modal>
  );
};

export default FactorySensorHistoryModal;
