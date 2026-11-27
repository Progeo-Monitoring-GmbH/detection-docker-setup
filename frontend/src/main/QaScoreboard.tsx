import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { Spinner } from 'react-bootstrap';
import { ChevronDown, ChevronUp, Trophy } from 'react-bootstrap-icons';
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
  dailyGain,
  formatPoints,
  formatScore,
  scoreboardDays,
  userColors,
  type QaUser,
  type Scoreboard,
} from './qaScoreboardData';
import { useLatestRef } from '../components/ui/useLatestRef';
import './QaScoreboard.css';

// Plotly only once the scoreboard is loaded - not with the checklist.
const QaScoreboardChart = lazy(() => import('./QaScoreboardChart'));

type RankedUser = QaUser & { rank: number; last: string | null; daily: number };

/**
 * The readiness scoreboard (checklist overview): the mean score of all
 * locations over time and each staff member's points for the checks they
 * fixed - loaded on demand ("Load scoreboard").
 */
// Minimized or not - this viewer's choice, kept in the browser (per device).
const COLLAPSED_KEY = 'progeo_qa_scoreboard_collapsed';

const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};

const QaScoreboard = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [board, setBoard] = useState<Scoreboard | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () =>
    setCollapsed((current) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, current ? '0' : '1');
      } catch {
        // No storage (private window): minimized for this visit only.
      }
      return !current;
    });
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
  const loadRef = useLatestRef(load);
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
  }, [loaded, loadRef]);

  const colors = useMemo(() => userColors(board?.users ?? []), [board]);

  const ranked: RankedUser[] = useMemo(() => {
    const days = board ? scoreboardDays(board) : 1;
    return (board?.users ?? []).map((user, index) => ({
      ...user,
      rank: index + 1,
      daily: dailyGain(user, days),
      last: user.awards.length ? user.awards[user.awards.length - 1].at : null,
    }));
  }, [board]);

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
        // "⌀ Tageszuwachs": the points per day since the scoreboard starts.
        id: 'daily',
        name: (
          <span title={t('qa_column_daily_hint')}>{t('qa_column_daily')}</span>
        ),
        right: true,
        sortable: true,
        selector: (row) => row.daily,
        cell: (row) => formatPoints(row.daily),
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
      // Minimizes itself (collapsed).
      foldable={false}
      title={
        <span className="qa-scoreboard-title">
          <Trophy aria-hidden="true" /> {t('qa_scoreboard_title')}
        </span>
      }
      actions={
        <div className="qa-scoreboard-actions">
          {!collapsed && (
            <PillButton
              label={
                board ? t('qa_scoreboard_reload') : t('qa_scoreboard_load')
              }
              onClick={() => load()}
              disabled={loading}
              icon={
                loading ? <Spinner animation="border" size="sm" /> : undefined
              }
              testId="qa-scoreboard-load"
            />
          )}
          <button
            type="button"
            className="qa-scoreboard-toggle"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            title={
              collapsed
                ? t('qa_scoreboard_expand')
                : t('qa_scoreboard_collapse')
            }
            aria-label={
              collapsed
                ? t('qa_scoreboard_expand')
                : t('qa_scoreboard_collapse')
            }
            data-testid="qa-scoreboard-toggle"
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      }
      // Minimized: the header only (the body stays mounted, a loaded board is kept).
      className={collapsed ? 'qa-scoreboard--collapsed' : undefined}
      bodyClassName="qa-scoreboard-body"
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
