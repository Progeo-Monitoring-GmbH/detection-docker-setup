import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { Spinner } from 'react-bootstrap';
import { Trophy } from 'react-bootstrap-icons';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import KpiStrip from '../components/ui/kit/KpiStrip';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SearchableDataTable, {
  type SearchableColumn,
} from '../components/ui/kit/SearchableDataTable';
import { formatDate } from './dateFormat';
import {
  QA_UPDATED_EVENT,
  formatPoints,
  formatScore,
  userColors,
  type QaUser,
  type Scoreboard,
} from './qaScoreboardData';
import './QaScoreboard.css';

// Plotly only once the scoreboard is loaded - not with the checklist.
const QaScoreboardChart = lazy(() => import('./QaScoreboardChart'));

type RankedUser = QaUser & { rank: number; last: string | null };

/**
 * The readiness scoreboard (checklist overview): the mean score of all
 * locations over time and each staff member's points for the checks they
 * fixed - loaded on demand ("Load scoreboard").
 */
const QaScoreboard = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [board, setBoard] = useState<Scoreboard | null>(null);
  const [loading, setLoading] = useState(false);

  // `quiet`: a reload after a point change - the shown board stays until the new one is there.
  const load = (quiet = false) => {
    if (!quiet) {
      setLoading(true);
    }
    void axiosConfig.perform_get(
      auth,
      '/v1/qa/scoreboard/',
      (response) => {
        setBoard(response?.data as Scoreboard);
        setLoading(false);
      },
      (error) => {
        setLoading(false);
        if (!quiet) {
          showRequestError(enqueueSnackbar, t('qa_scoreboard_failed'), error);
        }
      },
    );
  };

  // Once loaded, it follows the points live (QaAwardToasts passes the
  // socket's changes on) - a burst of changes reloads it once.
  const loaded = board !== null;
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (!loaded) {
      return undefined;
    }
    let timer: number | undefined;
    const onUpdate = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => loadRef.current(true), 800);
    };
    window.addEventListener(QA_UPDATED_EVENT, onUpdate);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(QA_UPDATED_EVENT, onUpdate);
    };
  }, [loaded]);

  const colors = useMemo(() => userColors(board?.users ?? []), [board]);

  const ranked: RankedUser[] = useMemo(
    () =>
      (board?.users ?? []).map((user, index) => ({
        ...user,
        rank: index + 1,
        last: user.awards.length
          ? user.awards[user.awards.length - 1].at
          : null,
      })),
    [board],
  );

  const columns: SearchableColumn<RankedUser>[] = useMemo(
    () => [
      {
        id: 'rank',
        name: '#',
        width: '56px',
        sortable: true,
        selector: (row) => row.rank,
      },
      {
        id: 'user',
        name: t('qa_column_user'),
        sortable: true,
        selector: (row) => row.username.toLowerCase(),
        cell: (row) => (
          <span className="qa-scoreboard-user">
            {/* The line's colour beside the name - the name carries the identity. */}
            <span
              className="qa-scoreboard-swatch"
              style={{ backgroundColor: colors.get(row.id) ?? 'transparent' }}
              aria-hidden="true"
            />
            {row.username}
          </span>
        ),
        searchText: (row) => row.username,
      },
      {
        id: 'points',
        name: t('qa_column_points'),
        right: true,
        sortable: true,
        selector: (row) => row.total,
        cell: (row) => <strong>{formatPoints(row.total)}</strong>,
      },
      {
        id: 'fixes',
        name: t('qa_column_fixes'),
        right: true,
        sortable: true,
        selector: (row) => row.count,
      },
      {
        id: 'last',
        name: t('qa_column_last'),
        sortable: true,
        selector: (row) => row.last ?? '',
        cell: (row) => (row.last ? formatDate(row.last) : '–'),
      },
    ],
    [colors, t],
  );

  const kpis = useMemo(() => {
    if (!board) {
      return [];
    }
    const first = board.mean[0];
    const today = board.mean[board.mean.length - 1];
    const earned = board.users.reduce((sum, user) => sum + user.total, 0);
    const fixes = board.users.reduce((sum, user) => sum + user.count, 0);
    const change = first && today ? today.score - first.score : null;
    return [
      {
        label: t('qa_kpi_mean'),
        value: today ? formatScore(today.score) : '–',
        unit: '/ 100',
        note: today
          ? t('qa_mean_locations', { count: today.locations })
          : undefined,
        testId: 'qa-kpi-mean',
      },
      {
        label: t('qa_kpi_change'),
        value: change === null ? '–' : formatScore(change, true),
        note: first
          ? t('qa_kpi_since', {
              date: formatDate(`${first.day}T12:00:00`, 'date'),
            })
          : undefined,
        testId: 'qa-kpi-change',
      },
      {
        label: t('qa_kpi_earned'),
        value: formatPoints(earned),
        note: t('qa_kpi_fixes', { count: fixes }),
        testId: 'qa-kpi-earned',
      },
      {
        label: t('qa_kpi_unattributed'),
        value: formatPoints(board.unattributed.total),
        note: t('qa_kpi_fixes', { count: board.unattributed.count }),
        testId: 'qa-kpi-unattributed',
      },
    ];
  }, [board, t]);

  return (
    <PanelCard
      title={
        <span className="qa-scoreboard-title">
          <Trophy aria-hidden="true" /> {t('qa_scoreboard_title')}
        </span>
      }
      actions={
        <PillButton
          label={board ? t('qa_scoreboard_reload') : t('qa_scoreboard_load')}
          onClick={() => load()}
          disabled={loading}
          icon={loading ? <Spinner animation="border" size="sm" /> : undefined}
          testId="qa-scoreboard-load"
        />
      }
      testId="qa-scoreboard"
    >
      <div className="small text-muted">{t('qa_scoreboard_intro')}</div>
      {board && (
        <>
          <KpiStrip tiles={kpis} testId="qa-scoreboard-kpis" />
          <Suspense
            fallback={
              <div className="qa-scoreboard-plot-loading">
                <Spinner animation="border" size="sm" />
              </div>
            }
          >
            <QaScoreboardChart board={board} colors={colors} />
          </Suspense>
          {board.users.every((user) => user.count === 0) && (
            <div className="small text-muted" data-testid="qa-scoreboard-empty">
              {t('qa_scoreboard_empty')}
            </div>
          )}
          <SearchableDataTable<RankedUser>
            columns={columns}
            data={ranked}
            dense
            testId="qa-scoreboard-table"
            mobileColumns={['rank', 'user', 'points']}
          />
        </>
      )}
    </PanelCard>
  );
};

export default QaScoreboard;
