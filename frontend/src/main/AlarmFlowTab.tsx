import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from 'react-bootstrap';
import { ArrowRepeat } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import PanelCard from '../components/ui/kit/PanelCard';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import { FLOW_URL, type FlowAnswer } from './alarmFlow';
import AlarmFlowTimeline from './AlarmFlowTimeline';
import './AlarmFlow.css';

/** The list follows the sender: it sends at most every few minutes. */
const RELOAD_MS = 60_000;
/** The countdowns tick in between. */
const TICK_MS = 30_000;

/**
 * /escalations/?view=flow (staff): every open notification case as a
 * timeline, the next message first. Read only - the actions (mute, close)
 * stay in the staff area, each case links there.
 */
const AlarmFlowTab = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [answer, setAnswer] = useState<FlowAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    void axiosConfig.perform_get(
      auth,
      FLOW_URL,
      (response) => {
        setAnswer((response?.data ?? null) as FlowAnswer | null);
        setFailed(false);
        setNow(Date.now());
      },
      (error) => {
        setFailed(true);
        showRequestError(enqueueSnackbar, t('flow_load_failed'), error);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
    const reload = window.setInterval(load, RELOAD_MS);
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      window.clearInterval(reload);
      window.clearInterval(tick);
    };
  }, [load]);

  const cases = answer?.cases ?? [];
  return (
    <PanelCard
      testId="alarm-flow"
      title={t('flow_title')}
      actions={
        <Button
          size="sm"
          variant="link"
          onClick={load}
          title={t('escalation_refresh')}
          aria-label={t('escalation_refresh')}
          data-testid="alarm-flow-refresh"
        >
          <ArrowRepeat />
        </Button>
      }
    >
      <div className="alarm-flow-hint">{t('flow_hint', { minutes: answer?.run_minutes ?? 15 })}</div>
      {answer?.total != null && answer.total > cases.length && (
        <div className="alarm-flow-hint" data-testid="alarm-flow-truncated">
          {t('flow_truncated', { shown: cases.length, total: answer.total })}
        </div>
      )}
      {answer == null && !failed ? (
        <div className="d-flex justify-content-center py-4 text-muted" data-testid="alarm-flow-loading">
          <Spinner size="sm" animation="border" />
        </div>
      ) : cases.length === 0 ? (
        <div className="text-muted py-3" data-testid="alarm-flow-empty">
          {failed ? t('flow_load_failed') : t('flow_empty')}
        </div>
      ) : (
        <div className="alarm-flow-list">
          {cases.map((flow) => (
            <AlarmFlowTimeline key={flow.id} flow={flow} now={now} />
          ))}
        </div>
      )}
    </PanelCard>
  );
};

export default AlarmFlowTab;
